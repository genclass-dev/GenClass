// The dev-only coding-agent link (src/agentlink.mjs) on what the runtime CLI's init writes for each framework
// (packages/runtime/bin/lib/plan.mjs), and `remove` taking it out again (packages/runtime/bin/lib/edit.mjs
// planRemoval): every form round-trips to the files as they were before init, with no problem reported.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectProject } from "../../runtime/bin/lib/detect.mjs";
import { hasMarker, planRemoval } from "../../runtime/bin/lib/edit.mjs";
import { inspectProject } from "../../runtime/bin/lib/init.mjs";
import { planInit } from "../../runtime/bin/lib/plan.mjs";
import { PKG_DIR, VERSION } from "../../runtime/bin/lib/version.mjs";
import { connectAgent, SKILL_PATH } from "../src/actions.mjs";
import { AGENT_END, AGENT_START, devCommand, devCondition, linkLines, planAgentLink, seeItNow, withAgentLink, withAstroAgentLink } from "../src/agentlink.mjs";
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
    const created = text.includes("genclass:init start") && r.text.trim() === "";
    if (!created) out[rel] = r.text;
  }
  return out;
}

type Opts = { devtools?: boolean; config?: Record<string, unknown>; strategy?: string };

/** A project with `files`, set up by init's own plan (written as init writes it), then its link planned. */
function initThenLink(files: Record<string, string>, o: Opts = {}) {
  const dir = tempDir("genclass-link-");
  write(dir, files);
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

describe("the coding-agent link on every setup init writes, and `remove` taking it out (src/agentlink.mjs; runtime edit.mjs planRemoval)", () => {
  it("Vite (React, Vue, Svelte, Solid, Preact): a block right after init's import, import.meta.env.DEV, in the file's own style", () => {
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
        expect(lines.slice(at + 1, at + 6), `${entry} devtools=${devtools}`).toEqual(single ? STATIC_LINK("import.meta.env.DEV", "'", "") : STATIC_LINK("import.meta.env.DEV"));
      }
    }
  });

  it("Vite with the options file (--no-telemetry): after the /auto import, not the options import; CRLF and no final newline kept", () => {
    const { changes } = roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.ts"), "src/main.ts": `console.log("app");\n` }, { config: { telemetry: false } });
    expect(changes[0]!.after.split("\n").slice(0, 3)).toEqual(['import "./genclass.config"; // genclass:init', 'import "@genclass/runtime/auto"; // genclass:init', AGENT_START]);
    const crlf = roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.js"), "src/main.js": `import "./style.css";\r\nconsole.log(1);\r\n` });
    expect(crlf.changes[0]!.after).toContain(`${AGENT_START}\r\n`);
    expect(crlf.changes[0]!.after).not.toMatch(/[^\r]\n/);
    roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.js"), "src/main.js": `console.log(1);` });
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
    // an instrumentation-client of the app's own: after init's line in it
    const own = roundTrip({ ...next16, "src/instrumentation-client.ts": `console.log("mine");\n` }, { devtools: true });
    expect(own.changes[0]!.after.split("\n").slice(0, 2)).toEqual(['import genclass from "@genclass/runtime/auto"; // genclass:init', expect.stringContaining("genclass:init start: the coding-agent link")]);
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
    expect(wp.changes[0]!.after.split("\n").slice(0, 3)).toEqual(['"use strict";', 'import "@genclass/runtime/auto"; // genclass:init', AGENT_START]);
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
      write(dir, files);
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
