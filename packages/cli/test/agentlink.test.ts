// The dev-only coding-agent link (src/agentlink.mjs) on what the runtime CLI's init writes for each framework
// (packages/runtime/bin/lib/plan.mjs), and `remove` taking it out again (packages/runtime/bin/lib/edit.mjs
// planRemoval, createdByInit): the link is a file of its own and one marked import line in the entry, every file the
// planner writes or edits parses (esbuild), the entry is otherwise byte for byte what it was, and every form
// round-trips to the files as they were before init, with no problem reported.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { buildSync, transformSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectProject } from "../../runtime/bin/lib/detect.mjs";
import { createdByInit, hasMarker, planRemoval } from "../../runtime/bin/lib/edit.mjs";
import { inspectProject } from "../../runtime/bin/lib/init.mjs";
import { planInit } from "../../runtime/bin/lib/plan.mjs";
import { channelOf, PKG_DIR, VERSION } from "../../runtime/bin/lib/version.mjs";
import { connectAgent, SKILL_PATH } from "../src/actions.mjs";
import { AGENT_END, AGENT_FILE_START, AGENT_START, agentFileText, devCommand, devCondition, installedRuntime, linkFileFor, linkLines, linkSpecifier, planAgentLink, runtimeUpgrade, seeItNow, withAgentLink, withAstroAgentLink } from "../src/agentlink.mjs";
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

/** esbuild's loader for a file: JSX in .js files too (Create React App's and Next.js's have it). */
const loaderOf = (rel: string) => (/\.tsx$/.test(rel) ? "tsx" : /\.[cm]?ts$/.test(rel) ? "ts" : "jsx");
/** Fails the test unless `text` parses as `rel` (an Astro file: its frontmatter and each inline <script>, as TypeScript). */
function parses(rel: string, text: string) {
  const parts = rel.endsWith(".astro") ? [/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "", ...[...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)] : [text];
  for (const code of parts) {
    try {
      transformSync(code, { loader: rel.endsWith(".astro") ? "ts" : loaderOf(rel), format: "esm", logLevel: "silent" });
    } catch (e) {
      expect.fail(`${rel} does not parse: ${(e as Error).message}\n${text}`);
    }
  }
}

/** The one line the link added to an entry, and where: the rest is the entry as it was, byte for byte. */
function addedLine(before: string, after: string): { line: string; at: number } {
  const parts = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (let i = 0; i < parts.length; i++) {
    if ([...parts.slice(0, i), ...parts.slice(i + 1)].join("") === before) return { line: parts[i]!.replace(/\r?\n$/, ""), at: i };
    // the entry's last line had no line break: the line went after one, and the file still ends without one
    if (i === parts.length - 1 && parts.slice(0, i).join("").replace(/\r?\n$/, "") === before) return { line: parts[i]!, at: i };
  }
  return expect.fail(`not one line added:\n${before}\n---\n${after}`);
}

type Opts = { devtools?: boolean; config?: Record<string, unknown>; strategy?: string; runtime?: string | null };
type Change = { file: string; rel: string; kind: string; before: string; after: string; what: string };

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

/**
 * Writes the planned link and checks it: each file the planner writes or edits parses, the link's file is new and
 * comes first, an entry gets exactly one line (its marked import of that file, which names it), the link is there
 * once, and `remove` gives back the files from before init.
 */
function roundTrip(files: Record<string, string>, o: Opts = {}) {
  const { dir, before, link } = initThenLink(files, o);
  expect(link.state, JSON.stringify(link)).toBe("planned");
  const changes = link.changes as Change[];
  const made = changes.filter((ch) => ch.kind === "create");
  expect(changes.map((ch) => ch.kind)).toEqual([...made.map(() => "create"), ...changes.slice(made.length).map(() => "modify")]);
  for (const ch of changes) {
    parses(ch.rel, ch.after);
    if (ch.kind === "create") {
      expect(existsSync(ch.file)).toBe(false);
      expect(ch.after.startsWith(`${AGENT_FILE_START}\n`) || ch.after.startsWith(`${AGENT_FILE_START}\r\n`), ch.after).toBe(true);
      continue;
    }
    if (ch.rel.endsWith(".astro")) continue;
    const { line } = addedLine(ch.before, ch.after);
    const spec = /^\s*import\s+["']([^"']+)["'];? \/\/ genclass:init$/.exec(line)?.[1];
    expect(spec, line).toBeDefined();
    const target = resolve(dirname(ch.file), /\.js$/.test(spec!) ? spec! : `${spec}.ts`);
    expect(made.some((m) => resolve(m.file) === target) || existsSync(target), `${ch.rel} imports ${spec}`).toBe(true);
  }
  for (const ch of changes) writeFileSync(ch.file, ch.after);
  const linked = snapshot(dir);
  // planned again: it is there now
  expect(planAgentLink(inspectProject({ cwd: dir })).state).toBe("linked");
  expect(removed(dir)).toEqual(before);
  return { dir, linked, changes };
}

const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "app", private: true, dependencies: deps, ...extra }, null, 2) + "\n";
const html = (src: string) => `<!doctype html>\n<html lang="en">\n  <head>\n    <title>App</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="${src}"></script>\n  </body>\n</html>\n`;
/** The link's file as the planner writes it (literal, so the test does not lean on agentFileText). */
const LINK_FILE = (cond: string, { q = '"', semi = ";", client = false, bound = false, eol = "\n" } = {}) =>
  [
    AGENT_FILE_START,
    ...(client ? [`${q}use client${q}${semi}`, ""] : []),
    `import { GenClass } from ${q}@genclass/runtime${q}${semi}`,
    ...(bound ? [] : [`import { connectAgent } from ${q}@genclass/runtime/agent${q}${semi}`]),
    "",
    bound ? `if (${cond}) import(${q}@genclass/runtime/agent${q}).then(({ connectAgent }) => connectAgent(GenClass.init()))${semi}` : `if (${cond}) connectAgent(GenClass.init())${semi}`,
    AGENT_END,
    "",
  ].join(eol);
const NODE = 'process.env.NODE_ENV === "development"';
const NODE_SSR = 'process.env.NODE_ENV === "development" && typeof window !== "undefined"';
/** The change to `rel` in a plan. */
const changeOf = (changes: Change[], rel: string) => changes.find((ch) => ch.rel === rel)!;

/** A stub runtime in node_modules for running or bundling an entry: /auto, the main entry and the agent entry. */
const STUB = {
  "node_modules/@genclass/runtime/package.json": JSON.stringify({ name: "@genclass/runtime", version: OWN.version, type: "module", sideEffects: ["./auto.js"], exports: { ".": "./index.js", "./auto": "./auto.js", "./agent": "./agent.js" } }),
  "node_modules/@genclass/runtime/index.js": 'export const GenClass = { init: () => "the runtime" };\n',
  "node_modules/@genclass/runtime/auto.js": 'globalThis.AUTO_RAN = true;\nexport default "the runtime";\n',
  "node_modules/@genclass/runtime/agent.js": "export function connectAgent(rt) { console.log(`connectAgent ran: ${rt}`); }\n",
  "src/app.js": 'export const start = () => console.log("app started");\n',
};

describe("the coding-agent link on every setup init writes, and `remove` taking it out (src/agentlink.mjs; runtime edit.mjs planRemoval)", () => {
  it("Vite (React, Vue, Svelte, Solid, Preact): genclass.agent.(ts|js) next to the entry, imported right after init's import, import.meta.env.DEV, in the entry's own style", () => {
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
        const ts = /\.tsx?$/.test(entry);
        const file = ts ? "src/genclass.agent.ts" : "src/genclass.agent.js";
        expect(changes.map((ch) => ch.rel)).toEqual([file, entry]);
        const single = text.startsWith("import { createRoot } from 'react-dom/client'");
        const [q, semi] = single ? ["'", ""] : ['"', ";"];
        expect(changeOf(changes, file).after, `${entry} devtools=${devtools}`).toBe(LINK_FILE("import.meta.env.DEV", { q, semi }));
        // the line right after init's /auto import: the second line, before the app's own imports
        const { line, at } = addedLine(changeOf(changes, entry).before, changeOf(changes, entry).after);
        expect(at).toBe(1);
        expect(line).toBe(`import ${q}./genclass.agent${ts ? "" : ".js"}${q}${semi} // genclass:init`);
        expect(changeOf(changes, entry).after.split("\n")[0]).toContain("@genclass/runtime/auto");
      }
    }
  });

  it("Vite with the options file (--no-telemetry): after the /auto import, not the options import; CRLF and no final newline kept", () => {
    const { changes } = roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.ts"), "src/main.ts": `console.log("app");\n` }, { config: { telemetry: false } });
    expect(changes.map((ch) => ch.rel)).toEqual(["src/genclass.agent.ts", "src/main.ts"]);
    expect(changes[1]!.after.split("\n").slice(0, 4)).toEqual(['import "./genclass.config"; // genclass:init', 'import "@genclass/runtime/auto"; // genclass:init', 'import "./genclass.agent"; // genclass:init', 'console.log("app");']);
    // CRLF: the line and the link's file end with CRLF too
    const crlf = roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.js"), "src/main.js": `import "./style.css";\r\nconsole.log(1);\r\n` });
    expect(crlf.changes[1]!.after).toBe(`import "@genclass/runtime/auto"; // genclass:init\r\nimport "./genclass.agent.js"; // genclass:init\r\nimport "./style.css";\r\nconsole.log(1);\r\n`);
    expect(crlf.changes[0]!.after).toBe(LINK_FILE("import.meta.env.DEV", { eol: "\r\n" }));
    // no final newline, and an entry holding nothing but init's line
    roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.js"), "src/main.js": `import "./style.css";` });
    const only = roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.js"), "src/main.js": "" });
    expect(only.changes[1]!.after).toBe('import "@genclass/runtime/auto"; // genclass:init\nimport "./genclass.agent.js"; // genclass:init\n');
  });

  it("Create React App: the line is in the import section (react-app's ESLint import/first fails `npm start` and `npm run build` otherwise)", () => {
    const index = `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport './index.css';\nimport App from './App';\nimport reportWebVitals from './reportWebVitals';\n\nconst root = ReactDOM.createRoot(document.getElementById('root'));\nroot.render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);\n\nreportWebVitals();\n`;
    const files = { "package.json": pkg({ "react-scripts": "5.0.1", react: "^18", "react-dom": "^18" }, { eslintConfig: { extends: ["react-app", "react-app/jest"] } }), "src/index.js": index };
    for (const devtools of [false, true]) {
      const { changes } = roundTrip(files, { devtools });
      const lines = changes[1]!.after.split("\n");
      expect(lines.slice(1, 3)).toEqual(["import './genclass.agent.js'; // genclass:init", "import React from 'react';"]);
      expect(changes[0]!.after).toBe(LINK_FILE(NODE, { q: "'" }));
    }
  });

  it("SvelteKit: after the block of the hooks.client file init created (remove deletes both files), or after its line in an existing one", () => {
    const made = roundTrip({ "package.json": pkg({ "@sveltejs/kit": "^2" }), "tsconfig.json": "{}\n", "src/routes/+page.svelte": "<h1>hi</h1>\n" });
    expect(made.changes.map((ch) => ch.rel)).toEqual(["src/genclass.agent.ts", "src/hooks.client.ts"]);
    const lines = made.changes[1]!.after.trimEnd().split("\n");
    expect(lines.slice(-2)).toEqual(["// genclass:init end", 'import "./genclass.agent"; // genclass:init']);
    const own = roundTrip({ "package.json": pkg({ "@sveltejs/kit": "^2" }), "src/hooks.client.js": `export const handleError = ({ error }) => console.error(error);` }, { devtools: true });
    expect(own.changes.map((ch) => ch.rel)).toEqual(["src/genclass.agent.js", "src/hooks.client.js"]);
  });

  it("Astro: a second marked <script> line after init's, in each layout (it parses); a one-line <head> gets the lines to add instead", () => {
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
    expect(rr.changes.map((ch) => ch.rel)).toEqual(["app/genclass.agent.ts", "app/entry.client.tsx"]);
    expect(rr.changes[0]!.after).toBe(LINK_FILE("import.meta.env.DEV"));
    const remix = roundTrip({ "package.json": pkg({ "@remix-run/react": "^2", vite: "^5" }), "app/root.tsx": `export default function App() { return null; }\n` }, { devtools: true });
    expect(remix.changes[0]!.after).toBe(LINK_FILE('import.meta.env.DEV && typeof window !== "undefined"'));
    const old = roundTrip({ "package.json": pkg({ "@remix-run/react": "^2" }), "app/entry.client.jsx": `import { RemixBrowser } from "@remix-run/react";\n` });
    expect(old.changes[0]!.after).toBe(LINK_FILE(NODE));
  });

  it('Next.js: "use client" first, as in init\'s genclass-init; instrumentation-client (made or edited), the genclass-init component, pages/_app (its file in the folder above pages/); the dynamic import where init bound `genclass`', () => {
    const layout = `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
    const next16 = { "package.json": pkg({ next: "16.0.0", react: "^19" }), "tsconfig.json": "{}\n", "node_modules/next/package.json": JSON.stringify({ name: "next", version: "16.0.1" }), "src/app/layout.tsx": layout };
    // made by init, no binding (the genclass command's init: --no-devtools): the two imports and the call
    const made = roundTrip(next16);
    expect(made.changes.map((ch) => ch.rel)).toEqual(["src/genclass.agent.ts", "src/instrumentation-client.ts"]);
    expect(made.changes[0]!.after).toBe(LINK_FILE(NODE, { client: true }));
    expect(made.changes[1]!.after.trimEnd().split("\n").slice(-2)).toEqual(["// genclass:init end", 'import "./genclass.agent"; // genclass:init']);
    // with init's `genclass` binding (the devtools line): the agent entry imported as that line imports the devtools
    const bound = roundTrip(next16, { devtools: true });
    expect(bound.changes[0]!.after).toBe(LINK_FILE(NODE, { client: true, bound: true }));
    // an instrumentation-client of the app's own, with an IIFE right after its imports: one line, nothing else changed
    const own = roundTrip({ ...next16, "src/instrumentation-client.ts": `import "./mine";\n(() => { console.log("mine") })()\n` }, { devtools: true });
    expect(own.changes[1]!.after.split("\n").slice(0, 4)).toEqual(['import genclass from "@genclass/runtime/auto"; // genclass:init', 'import "./genclass.agent"; // genclass:init', 'import "./mine";', '(() => { console.log("mine") })()']);
    // Next.js 15.1, App Router: the client component init creates, rendered on the server too
    for (const devtools of [false, true]) {
      const app = roundTrip({ "package.json": pkg({ next: "15.1.0" }), "tsconfig.json": "{}\n", "app/layout.tsx": layout }, { devtools });
      expect(app.changes.map((ch) => ch.rel)).toEqual(["app/genclass.agent.ts", "app/genclass-init.tsx"]);
      expect(app.changes[0]!.after).toBe(LINK_FILE(NODE_SSR, { client: true, bound: devtools }));
    }
    // Next.js 14, pages: an _app of the app's own, and the one init creates; the link's file is never a page
    const withApp = roundTrip({ "package.json": pkg({ next: "14.2.0" }), "pages/_app.js": `import "../styles/globals.css";\n\nexport default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n`, "pages/index.js": "export default function Home() { return null; }\n" });
    expect(withApp.changes.map((ch) => ch.rel)).toEqual(["genclass.agent.js", "pages/_app.js"]);
    expect(withApp.changes[0]!.after).toBe(LINK_FILE(NODE_SSR, { client: true }));
    expect(withApp.changes[1]!.after.split("\n")[1]).toBe('import "../genclass.agent.js"; // genclass:init');
    const src = roundTrip({ "package.json": pkg({ next: "14.2.0" }), "tsconfig.json": "{}\n", "src/pages/index.tsx": "export default function Home() { return null; }\n" }, { devtools: true });
    expect(src.changes.map((ch) => ch.rel)).toEqual(["src/genclass.agent.ts", "src/pages/_app.tsx"]);
  });

  it("Create React App and webpack, rspack, rsbuild, parcel: process.env.NODE_ENV; another bundler gets the lines instead", () => {
    const cra = roundTrip({ "package.json": pkg({ "react-scripts": "5.0.1", react: "^18" }), "src/index.js": `import React from 'react';\n` });
    expect(cra.changes[0]!.after).toContain(`if (${NODE}) connectAgent(GenClass.init())`);
    const wp = roundTrip({ "package.json": pkg({ webpack: "^5", "html-webpack-plugin": "^5" }), "src/index.ts": `"use strict";\nconsole.log(1);\n` });
    expect(wp.changes[1]!.after.split("\n")).toEqual(['"use strict";', 'import "@genclass/runtime/auto"; // genclass:init', 'import "./genclass.agent"; // genclass:init', "console.log(1);", ""]);
    const es = initThenLink({ "package.json": pkg({ esbuild: "^0.25", "react-dom": "^19" }), "src/index.js": `console.log(1);\n` });
    expect(es.link).toMatchObject({ state: "manual", changes: null });
    expect(es.link.why).toContain("process.env.NODE_ENV");
  });

  it("the app's code is never parsed: shapes that broke the in-entry placement (a comment inside a multi-line import, import attributes on their own line, a block comment before a `(`, `[` or template line) get one line and still parse", () => {
    const shapes: [string, string][] = [
      ["src/main.jsx", `import { createRoot } from "react-dom/client";\nimport {\n  Button, // copied from "shadcn"\n  Card,\n} from "./ui";\n\ncreateRoot(document.getElementById("root")).render(<Button />);\n`],
      ["src/main.js", `import data from "./d.json"\n  with { type: "json" };\nconsole.log(data);\n`],
      ["src/main.js", `import data from "./d.json" with {\n  type: "json",\n};\n/* the app */\n// eslint-disable-next-line no-console\nconsole.log(data);\n`],
      ["src/main.js", `import { start } from "./app.js"\n\n/**\n * Start the app.\n */\n(async () => { start() })()\n`],
      ["src/main.js", `import { start } from "./app.js"\n/* go */\n[start].forEach((f) => f())\n`],
      ["src/main.js", "import { start } from \"./app.js\"\n/* go */\n`${start()}`\n"],
      ["src/main.ts", `import a from "a"; a(\n  1);\n`],
    ];
    for (const [entry, text] of shapes) {
      for (const devtools of [false, true]) {
        const { changes } = roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html(`/${entry}`), [entry]: text }, { devtools });
        // init's line, the link's line, then the app's code exactly as it was
        const after = changeOf(changes, entry).after;
        expect(after.split("\n").slice(2).join("\n").startsWith(text), after).toBe(true);
      }
    }
    // Next.js where init bound `genclass`, with an IIFE after its imports (Babel found the bound form joined to it)
    const next16 = { "package.json": pkg({ next: "16.0.0", react: "^19" }), "tsconfig.json": "{}\n", "node_modules/next/package.json": JSON.stringify({ name: "next", version: "16.0.1" }), "src/app/layout.tsx": "export default function L({ children }) { return <html><body>{children}</body></html>; }\n" };
    roundTrip({ ...next16, "src/instrumentation-client.ts": `import "./mine"\n\n/** go */\n(() => {})()\n` }, { devtools: true });
  });

  it("withAgentLink on the review's battery of entry shapes: one line after init's, the result parses wherever the entry did, and remove gives the entry back", () => {
    const H = 'import "@genclass/runtime/auto"; // genclass:init\n';
    const HN = 'import "@genclass/runtime/auto" // genclass:init\n';
    const HB = 'import genclass from "@genclass/runtime/auto" // genclass:init\n';
    const shapes: Record<string, string> = {
      jsdocIIFE: HN + 'import a from "./a"\n\n/**\n * Bootstrap\n */\n(async () => { await a() })()\n',
      blockIIFE: HN + "/* boot */\n(async () => {})()\n",
      blockArray: HN + 'import a from "./a"\n/* list */\n[1, 2].forEach(a)\n',
      blockTemplate: HN + 'import a from "./a"\n/* tag */\n`x`.trim()\n',
      boundJsdoc: HB + 'import "./mine"\n/** boot */\n(() => {})()\n',
      commentInMultiImport: H + 'import {\n  a, // was: from "old"\n  b,\n} from "./x";\nconsole.log(a, b);\n',
      attributesOwnLine: H + 'import d from "./d.json"\n  with { type: "json" };\nconsole.log(d);\n',
      attributesMulti: H + 'import d from "./d.json" with {\n  type: "json",\n};\nconsole.log(d);\n',
      tsAlias: H + "import Foo = Bar.Baz;\nconst x: number = 1;\nconsole.log(x, Foo);\n",
      exportFrom: H + 'import a from "a";\nexport { b } from "./b";\nconsole.log(a);\n',
      typeImportMulti: H + 'import type {\n  A,\n  B,\n} from "./types";\nimport { c } from "./c";\nconst v: A | B = c;\n',
      importMetaHot: H + 'import a from "a";\nimport.meta.hot?.accept();\n',
      stringsWithFrom: H + 'import a from "a";\nconst s = `\nimport b from "b"\n`;\nconsole.log(a, s);\n',
      crlf: H.replace("\n", "\r\n") + 'import a from "a";\r\n\r\nconsole.log(a);\r\n',
      sideEffectNoSemi: HN + 'import "./style.css"\nimport App from "./App.svelte"\nconst app = new App({ target: document.body })\nexport default app\n',
      codeOnImportLine: H + 'import a from "a"; a(\n  1);\n',
      regexNext: HN + 'import a from "./a"\n/a+/.test("aa") && a()\n',
      plusNext: HN + 'import a from "./a"\n+a\n',
      jsxNext: HN + 'import a from "./a"\n;<div />\n',
      parenRightAfter: HN + "(window).x = 1\n",
      onlyComments: H + "// nothing\n/* more */\n",
      eofNoNewline: H + 'import a from "a"',
      indented: '  import "@genclass/runtime/auto"; // genclass:init\n  import a from "a";\n  a();\n',
      topLevelAwait: HN + 'import a from "./a"\nawait a()\n',
    };
    for (const [name, text] of Object.entries(shapes)) {
      const after = withAgentLink(text, { spec: "./genclass.agent" })!;
      expect(after, name).not.toBeNull();
      // the second line, the rest as it was
      expect(addedLine(text, after), name).toMatchObject({ at: 1 });
      parses("src/main.tsx", text);
      parses("src/main.tsx", after);
      expect(planRemoval(after), name).toEqual({ text: planRemoval(text).text, problems: [] });
    }
  });

  it("Nuxt, Angular and a plain HTML script tag are not planned: the lines to add and where, nothing written", () => {
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
      parses("app/plugins/genclass.client.ts", readFileSync(plugin, "utf8"));
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
    expect(ok.changes.map((ch) => ch.rel)).toEqual(["src/genclass.agent.js", "src/main.js"]);
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

  it("the link runs right after /auto and before the app's code (Node ESM, a stub runtime): an entry that throws while it loads, awaits at the top, or opens with a commented IIFE", () => {
    const base = { "package.json": pkg({ webpack: "^5", "html-webpack-plugin": "^5" }, { type: "module" }), ...STUB };
    const run = (dir: string, env = "development") => spawnSync(process.execPath, [join(dir, "src/index.js")], { cwd: dir, encoding: "utf8", timeout: 20000, env: { ...process.env, NODE_ENV: env } });
    const runtime = STUB["node_modules/@genclass/runtime/package.json"];
    // the page's root element is not there (no document in Node): the entry throws on its first line of code
    const throws = roundTrip({ ...base, "src/index.js": `import { start } from "./app.js";\n\nstart(document.getElementById("root"));\n` }, { runtime });
    const t = run(throws.dir);
    expect(t.stderr).toContain("ReferenceError");
    expect(t.stdout).toContain("connectAgent ran: the runtime");
    // no semicolons, an IIFE right after the imports and a top-level await: linked before both
    const waits = roundTrip({ ...base, "src/index.js": `import { start } from "./app.js"\n(async () => { console.log("iife") })()\nawait new Promise((r) => setTimeout(r, 10))\nconsole.log("after the await")\nvoid start\n` }, { runtime });
    const w = run(waits.dir);
    expect(w.status, w.stderr).toBe(0);
    expect(w.stdout.split("\n").filter(Boolean)).toEqual(["connectAgent ran: the runtime", "iife", "after the await"]);
    // a JSDoc comment, then an IIFE, in a file without semicolons: the app still starts, in development (after the
    // link) and in production (no link); the in-entry call was joined to the IIFE ("connectAgent(...) is not a
    // function" in development, the app inside the dead branch in production)
    for (const app of [`import { start } from "./app.js"\n\n/**\n * Start the app.\n */\n(async () => { start() })()\n`, `import { start } from "./app.js"\n/* go */\n[start].forEach((f) => f())\n`, "import { start } from \"./app.js\"\n/* go */\n`${start()}`\n"]) {
      const iife = roundTrip({ ...base, "src/index.js": app }, { runtime });
      const dev = run(iife.dir);
      expect(dev.status, dev.stderr).toBe(0);
      expect(dev.stdout.split("\n").filter(Boolean), app).toEqual(["connectAgent ran: the runtime", "app started"]);
      const prod = run(iife.dir, "production");
      expect(prod.status, prod.stderr).toBe(0);
      expect(prod.stdout.split("\n").filter(Boolean), app).toEqual(["app started"]);
    }
  });

  it("a production build leaves the link out, a development build has it (esbuild with each build's define and the runtime's sideEffects)", () => {
    const bundle = (dir: string, entry: string, define: Record<string, string>) => buildSync({ entryPoints: [join(dir, entry)], bundle: true, write: false, format: "esm", minifySyntax: true, define, absWorkingDir: dir, logLevel: "silent", loader: { ".js": "jsx" } }).outputFiles[0]!.text;
    const vite = roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.ts"), ...STUB, "src/main.ts": `import { start } from "./app.js";\nstart();\n` }, { runtime: STUB["node_modules/@genclass/runtime/package.json"] });
    expect(bundle(vite.dir, "src/main.ts", { "import.meta.env.DEV": "false" })).not.toContain("connectAgent ran");
    expect(bundle(vite.dir, "src/main.ts", { "import.meta.env.DEV": "false" })).toContain("AUTO_RAN");
    expect(bundle(vite.dir, "src/main.ts", { "import.meta.env.DEV": "true" })).toContain("connectAgent ran");
    const cra = roundTrip({ "package.json": pkg({ "react-scripts": "5.0.1", react: "^18" }), ...STUB, "src/index.js": `import { start } from "./app.js";\nstart();\n` }, { runtime: STUB["node_modules/@genclass/runtime/package.json"] });
    expect(bundle(cra.dir, "src/index.js", { "process.env.NODE_ENV": '"production"' })).not.toContain("connectAgent ran");
    expect(bundle(cra.dir, "src/index.js", { "process.env.NODE_ENV": '"development"' })).toContain("connectAgent ran");
  });

  it("an entry file the person had, empty: `remove` gives it back empty, and deletes the link's file", () => {
    for (const [files, entry, file] of [
      [{ "package.json": pkg({ "@sveltejs/kit": "^2" }), "src/hooks.client.ts": "\n", "tsconfig.json": "{}\n" }, "src/hooks.client.ts", "src/genclass.agent.ts"],
      [{ "package.json": pkg({ next: "16.0.0", react: "^19" }), "tsconfig.json": "{}\n", "node_modules/next/package.json": JSON.stringify({ name: "next", version: "16.0.1" }), "src/app/layout.tsx": "export default function L({ children }) { return <html><body>{children}</body></html>; }\n", "src/instrumentation-client.ts": "" }, "src/instrumentation-client.ts", "src/genclass.agent.ts"],
    ] as [Record<string, string>, string, string][]) {
      const { changes } = roundTrip(files);
      expect(changes.map((ch) => ch.rel)).toEqual([file, entry]);
      const r = planRemoval(changes[1]!.after);
      expect(r.text).toBe(files[entry]);
      expect(createdByInit(changes[1]!.after, r.text)).toBe(false);
      const f = planRemoval(changes[0]!.after);
      expect(f).toEqual({ text: "", problems: [] });
      expect(createdByInit(changes[0]!.after, f.text)).toBe(true);
    }
  });

  it("half a link: an import line without its file gets the file, a file without its line gets the line; a genclass.agent file of the person's own is left alone", () => {
    const files = { "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.js"), "src/main.js": "start();\n" };
    const { dir, link } = initThenLink(files);
    const [made, edit] = link.changes as Change[];
    // the file deleted by hand: planned again, the file alone
    writeFileSync(edit!.file, edit!.after);
    const fileOnly = planAgentLink(inspectProject({ cwd: dir }));
    expect(fileOnly.state).toBe("planned");
    expect((fileOnly.changes as Change[]).map((ch) => [ch.rel, ch.kind])).toEqual([["src/genclass.agent.js", "create"]]);
    // the line taken out by hand: the file links nothing, so planned again, the line alone
    writeFileSync(made!.file, made!.after);
    writeFileSync(edit!.file, edit!.before);
    const lineOnly = planAgentLink(inspectProject({ cwd: dir }));
    expect(lineOnly.state).toBe("planned");
    expect((lineOnly.changes as Change[]).map((ch) => [ch.rel, ch.kind])).toEqual([["src/main.js", "modify"]]);
    expect((lineOnly.changes as Change[])[0]!.after).toBe(edit!.after);
    // a file of the person's own by that name: nothing written, the lines to add instead
    writeFileSync(made!.file, "export const agent = 1;\n");
    const taken = planAgentLink(inspectProject({ cwd: dir }));
    expect(taken).toMatchObject({ state: "manual", changes: null });
    expect(taken.why).toContain("src/genclass.agent.js is there already and is not GenClass's link");
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

  it("withAgentLink, agentFileText, linkFileFor and devCondition, directly: nothing twice, nothing without init's import, the check per framework and file", () => {
    const entry = 'import "@genclass/runtime/auto"; // genclass:init\nx();\n';
    const once = withAgentLink(entry)!;
    expect(once).toBe('import "@genclass/runtime/auto"; // genclass:init\nimport "./genclass.agent.js"; // genclass:init\nx();\n');
    expect(withAgentLink(once)).toBeNull();
    expect(withAgentLink(entry, { spec: "../genclass.agent" })).toContain('import "../genclass.agent"; // genclass:init\n');
    expect(withAgentLink("import { createRoot } from 'react-dom/client';\n")).toBeNull();
    expect(withAgentLink('import "@genclass/runtime/auto";\n')).toBeNull();
    // an indented marked line (a <script> block's code, say) keeps its indent
    expect(withAgentLink('  import "@genclass/runtime/auto"; // genclass:init\n')).toBe('  import "@genclass/runtime/auto"; // genclass:init\n  import "./genclass.agent.js"; // genclass:init\n');
    expect(agentFileText("import.meta.env.DEV")).toBe(LINK_FILE("import.meta.env.DEV"));
    expect(agentFileText(NODE, { q: "'", semi: "", client: true, bound: true })).toBe(LINK_FILE(NODE, { q: "'", semi: "", client: true, bound: true }));
    expect(linkFileFor({ framework: "vite" }, "/a/src/main.tsx")).toBe(join("/a/src", "genclass.agent.ts"));
    expect(linkFileFor({ framework: "next" }, "/a/src/pages/_app.jsx")).toBe(join("/a/src", "genclass.agent.js"));
    expect(linkSpecifier("/a/src/pages/_app.tsx", "/a/src/genclass.agent.ts")).toBe("../genclass.agent");
    expect(linkSpecifier("/a/src/main.mjs", "/a/src/genclass.agent.js")).toBe("./genclass.agent.js");
    expect(devCondition({ framework: "next" }, "/a/src/instrumentation-client.ts")).toBe(NODE);
    expect(devCondition({ framework: "next" }, "/a/app/genclass-init.tsx")).toBe(NODE_SSR);
    expect(devCondition({ framework: "remix", details: { vite: true } }, "/a/app/entry.client.tsx")).toBe("import.meta.env.DEV");
    expect(devCondition({ framework: "webpack", details: { bundler: "rollup" } }, "x.js")).toBeNull();
    for (const f of ["angular", "nuxt", "html"]) expect(devCondition({ framework: f }, "x.ts")).toBeNull();
    expect(linkLines({ framework: "vite" }).lines.at(-1)).toBe("if (import.meta.env.DEV) connectAgent(GenClass.init());");
  });

  it("formatter rewrites of the link still come out: braces (ESLint curly), wrapped lines (Prettier), single quotes; the earlier alpha's blocks in the entry too", () => {
    // the link's file, reformatted
    for (const body of [
      `import { GenClass } from '@genclass/runtime'\nimport { connectAgent } from '@genclass/runtime/agent'\n\nif (import.meta.env.DEV) {\n  connectAgent(GenClass.init())\n}`,
      `'use client'\n\nimport { GenClass } from '@genclass/runtime'\n\nif (process.env.NODE_ENV === 'development' && typeof window !== 'undefined')\n  import('@genclass/runtime/agent').then(({ connectAgent }) =>\n    connectAgent(GenClass.init()),\n  )`,
    ]) {
      const text = `${AGENT_FILE_START}\n${body}\n${AGENT_END}\n`;
      parses("src/genclass.agent.ts", text);
      const r = planRemoval(text);
      expect(r, body).toEqual({ text: "", problems: [] });
      expect(createdByInit(text, r.text)).toBe(true);
    }
    // the entry's line in single quotes, without the semicolon
    expect(planRemoval("import '@genclass/runtime/auto' // genclass:init\nimport './genclass.agent' // genclass:init\nx()\n")).toEqual({ text: "x()\n", problems: [] });
    // the earlier alpha's forms in the entry
    for (const body of [
      `if (import.meta.env.DEV) {\n  connectAgent(GenClass.init());\n}`,
      `if (process.env.NODE_ENV === 'development')\n  import('@genclass/runtime/agent').then(({ connectAgent }) =>\n    connectAgent(genclass),\n  );`,
      `if (process.env.NODE_ENV === "development") {\n  import("@genclass/runtime/agent").then(({ connectAgent }) => connectAgent(genclass));\n}`,
    ]) {
      const imports = body.includes("GenClass.init") ? `import { GenClass } from '@genclass/runtime'\nimport { connectAgent } from '@genclass/runtime/agent'\n` : "";
      const text = `import genclass from "@genclass/runtime/auto"; // genclass:init\n${AGENT_START}\n${imports}${body}\n${AGENT_END}\nx();\n`;
      expect(planRemoval(text), body).toEqual({ text: "x();\n", problems: [] });
    }
    // code of the person's own inside the link's file is a problem (remove then changes nothing) and is never deleted
    const edited = `${AGENT_FILE_START}\nimport { GenClass } from "@genclass/runtime";\nwindow.rt = GenClass.init();\n${AGENT_END}\n`;
    expect(planRemoval(edited).problems).toHaveLength(1);
    expect(planRemoval(edited).text).toBe(edited);
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
    // one preview: the MCP file's change and the link's changes (its new file, the entry's line), then what was written
    expect(said).toContain(".mcp.json");
    expect(said).toContain("src/genclass.agent.js (new file)");
    expect(said).toContain("src/main.jsx (modify)");
    expect(said).toContain("+ if (import.meta.env.DEV) connectAgent(GenClass.init());");
    expect(said).toContain('+ import "./genclass.agent.js"; // genclass:init');
    expect(said.indexOf("Wrote src/genclass.agent.js")).toBeGreaterThan(-1);
    expect(said.indexOf("Wrote src/genclass.agent.js")).toBeLessThan(said.indexOf("Linked src/main.jsx"));
    expect(said).toContain(SKILL_PATH);
    const flat = said.replace(/\s+/g, " ");
    expect(flat).toContain("See it work now (before any deploy)");
    expect(flat).toContain("Start your dev server (npm run dev) and open the page on localhost.");
    expect(flat).toContain("GenClass prints [GenClass] lines in the browser console");
    expect(flat).toContain('ask it "is GenClass connected?", or to explore a flow');
    const file = readFileSync(join(dir, "src/genclass.agent.js"), "utf8");
    expect(file).toContain("connectAgent(GenClass.init())");
    parses("src/genclass.agent.js", file);
    const linked = readFileSync(join(dir, "src/main.jsx"), "utf8");
    parses("src/main.jsx", linked);
    expect(addedLine(entry, linked)).toEqual({ line: 'import "./genclass.agent.js"; // genclass:init', at: 1 });
    const after = (await readState({ cwd: dir }, { runGit: () => null })).steps.find((x) => x.id === "agent")!;
    expect(after).toMatchObject({ state: "done", detail: ".mcp.json · dev page linked" });
    expect(planRemoval(linked)).toEqual({ text: planRemoval(entry).text, problems: [] });
    expect(createdByInit(file, planRemoval(file).text)).toBe(true);
  });

  it("the link's file is written before the line that imports it, and a write that fails stops there: the entry never imports a missing file", async () => {
    if (process.getuid?.() === 0) return; // root writes into a read-only folder
    const dir = setUpApp();
    write(dir, { ".mcp.json": JSON.stringify({ mcpServers: { genclass: { command: "npx", args: ["-y", "@genclass/mcp@0.2.2"] } } }) });
    const entry = readFileSync(join(dir, "src/main.jsx"), "utf8");
    // src/ read-only: a new file cannot be made there, while the entry (an existing file) could still be written
    chmodSync(join(dir, "src"), 0o555);
    try {
      const said = await printed(async () => expect(await connectAgent({ cwd: dir }, { yes: true })).toBe("failed"));
      expect(said).toContain("Could not write src/genclass.agent.js");
      expect(said).not.toContain("Linked src/main.jsx");
      expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toBe(entry);
      expect(existsSync(join(dir, "src/genclass.agent.js"))).toBe(false);
    } finally {
      chmodSync(join(dir, "src"), 0o755);
    }
  });

  it("`genclass remove` (the runtime's remove, then this command's files) gives back the app as it was before setup", async () => {
    const { remove } = await import("../src/remove.mjs");
    const apps: Record<string, string>[] = [
      { "package.json": pkg({ react: "^19", "react-dom": "^19", vite: "^8" }, { scripts: { dev: "vite" } }), "index.html": html("/src/main.jsx"), "src/main.jsx": `import { createRoot } from "react-dom/client";\n\ncreateRoot(document.getElementById("root")).render(null);\n` },
      { "package.json": pkg({ next: "16.0.0", react: "^19" }), "tsconfig.json": "{}\n", "node_modules/next/package.json": JSON.stringify({ name: "next", version: "16.0.1" }), "src/app/layout.tsx": "export default function L({ children }) { return <html><body>{children}</body></html>; }\n" },
      { "package.json": pkg({ next: "14.2.0" }), "pages/_app.js": `import "../styles/globals.css";\n\nexport default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n`, "pages/index.js": "export default function Home() { return null; }\n" },
      { "package.json": pkg({ "@sveltejs/kit": "^2" }), "tsconfig.json": "{}\n", "src/routes/+page.svelte": "<h1>hi</h1>\n" },
      { "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.js"), "src/main.js": `import { start } from "./app.js"\n\n/**\n * Start the app.\n */\n(async () => { start() })()\n` },
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
    expect(step.why).toBe("A dev-only file, src/genclass.agent.js, imported right after GenClass's import in src/main.jsx, lets your agent see the page you run. You see it first.");
    expect(readFileSync(join(dir, "src/genclass.agent.js"), "utf8")).toContain("connectAgent(GenClass.init())");
    expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toContain('import "./genclass.agent.js"; // genclass:init');
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
      // called on its own (not from the walk, where the step's Enter is the yes): one question for all of it
      type("n");
      const no = await printed(async () => expect(await connectAgent({ cwd: dir }, {})).toBe("skipped"));
      expect(no).toContain("Write .mcp.json, the skill and the dev-only link?");
      expect(no.match(/\(Y\/n\)/g)).toHaveLength(1);
      expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toBe(entry);
      // in the walk (confirmed: the step's Enter was the yes for the MCP server and the skill, 0.3.9): an edit to the
      // app's own source is still asked for once, after its diff (pre-release check, 2026-11-14)
      type("");
      const yes = await printed(async () => expect(await connectAgent({ cwd: dir }, { confirmed: true })).toBe("done"));
      expect(yes).toContain("src/genclass.agent.js");
      expect(yes.match(/\(Y\/n\)/g)).toHaveLength(1);
      expect(readFileSync(join(dir, "src/genclass.agent.js"), "utf8")).toContain("connectAgent(GenClass.init())");
      expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toContain('import "./genclass.agent.js"; // genclass:init');
      expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toContain("@genclass/mcp@");
      expect(readFileSync(join(dir, SKILL_PATH), "utf8")).toContain("genclass:init");
    });
  });
});

describe("no orphan link file, and doctor never calls a half link connected (review round 3)", () => {
  it("an entry that only mentions connectAgent (a comment, or its own function) gets no link file nothing imports", () => {
    for (const text of [
      `import { createRoot } from "react-dom/client";\n\n// connectAgent() for the coding agent: see README\ncreateRoot(document.getElementById("root")!).render(null);\n`,
      `import { connectAgent } from "./support/chat";\nconnectAgent({ room: "help" });\n`,
    ]) {
      const { link } = initThenLink({ "package.json": pkg({ react: "^19", "react-dom": "^19", vite: "^8" }), "index.html": html("/src/main.tsx"), "src/main.tsx": text });
      const made = (link.changes ?? []).filter((ch: Change) => ch.kind === "create");
      const edits = (link.changes ?? []).filter((ch: Change) => ch.kind === "modify");
      // a file is created only together with the line that imports it
      expect(made.length === 0 || edits.length > 0, JSON.stringify(link)).toBe(true);
    }
  });

  it("the link's file with its import line taken out by hand: doctor warns and --fix puts the line back", async () => {
    const files = { "package.json": pkg({ react: "^19", "react-dom": "^19", vite: "^8" }), "index.html": html("/src/main.tsx"), "src/main.tsx": `import { createRoot } from "react-dom/client";\n\ncreateRoot(document.getElementById("root")!).render(null);\n` };
    const { dir, link } = initThenLink(files);
    for (const ch of link.changes as Change[]) writeFileSync(ch.file, ch.after);
    // take the entry's import line out, keep the link's file
    const entry = join(dir, "src/main.tsx");
    writeFileSync(entry, readFileSync(entry, "utf8").split("\n").filter((l) => !l.includes("./genclass.agent")).join("\n"));
    const { checks } = await import("../src/doctor.mjs");
    const by = Object.fromEntries((await checks({ cwd: dir }, { offline: true, pathVersion: null, creds: null, listening: async () => false })).map((x: any) => [x.id, x]));
    expect(by.link.state).toBe("warn");
    expect(by.link.apply?.file ?? by.link.fix).toBeTruthy();
  });
});
