// `genclass privacy` (src/privacy.mjs) and `genclass doctor` (src/doctor.mjs): what a project's setup sends and keeps,
// read from its files; and whether what GenClass added is in place, with the fixes that are GenClass's own.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planRemoval } from "../../runtime/bin/lib/edit.mjs";
import { checks, compareVersions, cspGaps, doctor, importedFirst, withAgentLink } from "../src/doctor.mjs";
import { dataMap, isTestFile, markdown, privacy, readSetup, readSetupText, runtimeOf, stripComments } from "../src/privacy.mjs";
import { isolate, printed, tempDir, viteApp, write } from "./helpers.js";

isolate();

const INIT_ENTRY = 'import "./genclass.config"; // genclass:init\nimport "@genclass/runtime/auto"; // genclass:init\nimport { createRoot } from "react-dom/client";\n\ncreateRoot(document.getElementById("root")).render(null);\n';
const CONFIG = (opts: string) => `// genclass:init start: GenClass Runtime, added by \`npx genclass\`\n(globalThis as { GENCLASS_CONFIG?: object }).GENCLASS_CONFIG = { ${opts} };\n// genclass:init end\n`;

/** A Vite app with GenClass added as init adds it, with `opts` in its config file. */
function appWith(opts = 'token: "gc_AbCdEfGhIjKlMnOpQrStUv"', extra: Record<string, string> = {}) {
  const dir = tempDir();
  viteApp(dir);
  write(dir, { "src/main.jsx": INIT_ENTRY, "src/genclass.config.ts": CONFIG(opts), ...extra });
  return dir;
}

describe("genclass privacy: the setup, read from the project's files (src/privacy.mjs)", () => {
  it("reads the options that decide what is sent and kept", () => {
    expect(readSetupText('import "@genclass/runtime/auto";')).toMatchObject({ mode: "observe", telemetry: "on", analytics: false, situation: false, visual: "local", model: "cdn", learn: "none", sinks: [], agentLink: false });
    // learned state: nothing by default; flows with learn.expectations or learn.persist (runtime.ts, EXPECTATIONS.md section 4)
    expect(readSetupText("learn: { expectations: true }").learn).toBe("local");
    expect(readSetupText('learn: { persist: "session" }').learn).toBe("session");
    expect(readSetupText("learn: { expectations: true, persist: false }").learn).toBe("none");
    // the config in its own file, as init writes it (in the import's own module it would run after GenClass started)
    expect(readSetupText(['import "@genclass/runtime/auto/guard";', 'GENCLASS_CONFIG = { telemetry: false, learn: { persist: false }, model: { baseUrl: "/genclass-model/" } }'])).toMatchObject({ mode: "guard", telemetry: "off", model: "self", learn: "none" });
    expect(readSetupText('GenClass.init({ mode: "heal", telemetry: { endpoint: "https://collect.shop.example/v1", include: { situation: true } }, analytics: true, visual: { on: true, fix: true }, sinks: ["webhook:https://hooks.shop.example/g"] }); connectAgent(rt);')).toMatchObject({
      mode: "heal",
      telemetry: "own",
      endpoint: "collect.shop.example",
      analytics: true,
      situation: true,
      visual: "on, with fixes",
      sinks: ["hooks.shop.example"],
      agentLink: true,
    });
    expect(readSetupText('<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0/dist/genclass.global.min.js" data-mode="guard" data-telemetry="off" data-model="off"></script>')).toMatchObject({ mode: "guard", telemetry: "off", model: "off" });
  });

  it("the defaults: diagnostics to genclass.dev, the model from jsDelivr, learned flows in localStorage, and the lines that change each", () => {
    const m = dataMap({ ...readSetupText('import "@genclass/runtime/auto";'), token: true, files: [], installed: true, app: "shop" } as any);
    expect(m.sent.map((x) => x.to.split(" ")[0])).toEqual(["genclass.dev", "cdn.jsdelivr.net"]);
    expect(m.sent[0]!.what).toContain("No page text.");
    expect(m.sent[0]!.what).toContain("stores no IP address");
    expect(m.kept.map((x) => x.where)).toEqual(["Cache Storage"]);
    expect(m.strict.map(([opt]) => opt)).toEqual(['consent: "pending"', "telemetry: false", 'model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" }']);
    // guard and heal: the breaker's state after a trip, for the tab's session
    const guard = dataMap({ ...readSetupText('import "@genclass/runtime/auto/guard";'), token: true, files: [], installed: true } as any);
    expect(guard.kept.map((x) => x.where)).toEqual(["sessionStorage (genclass:breaker)", "Cache Storage"]);
    expect(m.csp).toEqual(["connect-src https://genclass.dev", "connect-src https://cdn.jsdelivr.net", "script-src 'wasm-unsafe-eval'", "worker-src 'self' (blob: for the script tag)"]);
    expect(m.eu.join(" ")).toContain("EDPB Guidelines 2/2023");
    expect(m.us.join(" ")).toContain("Global Privacy Control");
  });

  it("the strict setup sends nothing and keeps only the model files: there is nothing left to turn off but the model", () => {
    // the model and ONNX Runtime's wasm both from the site (baseUrl alone still fetches the wasm from jsDelivr: finding 32)
    const s = { ...readSetupText('GENCLASS_CONFIG = { telemetry: false, learn: { persist: false }, model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" } }'), token: false, files: [], installed: true, app: "shop" } as any;
    const m = dataMap(s);
    expect(m.sent).toEqual([]);
    expect(m.kept.map((x) => x.where)).toEqual(["Cache Storage"]);
    expect(m.strict).toEqual([]);
    expect(m.eu).toHaveLength(2);
    expect(m.eu[0]).toContain("sends nothing from the visitor's browser");
    expect(m.eu[1]).toContain("the model's files in Cache Storage");
    expect(m.csp).toEqual(["script-src 'wasm-unsafe-eval'", "worker-src 'self' (blob: for the script tag)"]);
  });

  it("the consent gate (the runtime's InitOptions.consent): read from the config, the meta tag and the script tag, with whether a banner passes the choice on", () => {
    expect(readSetupText('import "@genclass/runtime/auto";')).toMatchObject({ consent: null, consentCall: false });
    expect(readSetupText('GENCLASS_CONFIG = { consent: "pending" }')).toMatchObject({ consent: "pending", consentCall: false });
    expect(readSetupText("GENCLASS_CONFIG = { consent: { model: true } }")).toMatchObject({ consent: "pending" });
    expect(readSetupText('<meta name="genclass" content="consent=pending, mode=observe">')).toMatchObject({ consent: "pending" });
    expect(readSetupText('<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.4.0/dist/genclass.global.min.js" data-consent="pending"></script>')).toMatchObject({ consent: "pending" });
    expect(readSetupText("GenClass.init({ consent: 'denied' })")).toMatchObject({ consent: "denied" });
    expect(readSetupText('GENCLASS_CONFIG = { consent: "pending" }; onAccept((c) => GenClass.consent({ diagnostics: c.statistics }));')).toMatchObject({ consent: "pending", consentCall: true });
    expect(readSetupText("window.GenClass?.consent(true)").consentCall).toBe(true);
  });

  it('under consent: "pending" each recipient and stored entry waits for its part, the EU guidance says so, and a missing banner call is named', () => {
    const s = { ...readSetupText(['import "@genclass/runtime/auto";', 'GENCLASS_CONFIG = { consent: "pending", analytics: true }']), token: true, files: [], installed: true, app: "shop" } as any;
    const m = dataMap(s);
    expect(m.sent.map((x) => x.to.split(" ")[0])).toEqual(["genclass.dev", "genclass.dev,", "cdn.jsdelivr.net"]);
    expect(m.sent[0]!.why).toContain("Only after the visitor grants diagnostics");
    expect(m.sent[1]!.why).toContain("Only after the visitor grants analytics and diagnostics");
    expect(m.sent[2]!.why).toContain("Only after the visitor grants the model");
    expect(m.kept.map((x) => x.what).every((w) => w.includes("Only after the visitor grants"))).toBe(true);
    expect(m.eu[0]).toContain('GenClass waits for consent (consent: "pending")');
    expect(m.eu[0]).toContain("GenClass.consent({ diagnostics, analytics, storage, model })");
    expect(m.eu[1]).toContain("No call to GenClass.consent(...) was found");
    expect(m.eu.join(" ")).not.toContain("The careful choice");
    // the gate is set: it is not suggested again; the narrower lines still are
    expect(m.strict.map(([opt]) => opt)).not.toContain('consent: "pending"');
    expect(m.strict.map(([opt]) => opt)).toContain("telemetry: false");
    const md = markdown(s, m, "2026-11-14");
    expect(md).toContain('| Consent | waits for the visitor (consent: "pending"): nothing is sent, stored or downloaded until GenClass.consent(...) grants it; no GenClass.consent(...) call found in these files |');
    expect(md).toContain("TELEMETRY.md#consent");
    // with the banner's call found, no such line
    const called = dataMap({ ...readSetupText('GENCLASS_CONFIG = { consent: "pending" }; banner.on("save", (c) => GenClass.consent(c));'), token: true, files: [], installed: true } as any);
    expect(called.eu.join(" ")).not.toContain("No call to GenClass.consent");
  });

  it('without the gate, consent: "pending" is the first line for sites that need consent, and the EU guidance names it', () => {
    const m = dataMap({ ...readSetupText('import "@genclass/runtime/auto";'), token: true, files: [], installed: true } as any);
    expect(m.strict[0]![0]).toBe('consent: "pending"');
    expect(m.strict[0]![1]).toContain("for sites that need consent (EU, EEA, UK)");
    expect(m.eu[0]).toContain('The careful choice for EU, EEA and UK visitors is consent: "pending" with your consent banner calling GenClass.consent(...), or telemetry off.');
    expect(m.sent[0]!.why).not.toContain("Only after");
    // a denial at start: nothing runs until the code grants a part
    const denied = dataMap({ ...readSetupText("GenClass.init({ consent: 'denied' })"), token: false, files: [], installed: true } as any);
    expect(denied.eu[0]).toContain('consent: "denied"');
  });

  it("analytics count only with the app's key or an own endpoint; a page-text opt-in is named with what it can hold", () => {
    const off = dataMap({ ...readSetupText("analytics: true"), token: false, files: [], installed: true } as any);
    expect(off.sent.some((x) => x.what.startsWith("Interaction analytics"))).toBe(false);
    // page text is telemetry.include.situation; a top-level `include` is not an option
    const on = dataMap({ ...readSetupText("analytics: true, telemetry: { include: { situation: true } }"), token: true, files: [], installed: true } as any);
    expect(readSetupText("analytics: true, include: { situation: true }").situation).toBe(false);
    expect(on.sent[1]!.what).toMatch(/^Interaction analytics/);
    expect(on.sent[0]!.what).toContain("first 40 characters typed into ordinary inputs");
    expect(on.kept.map((x) => x.where)).toContain("localStorage (genclass.analytics.*)");
  });

  it("reads a real project: init's files, not its tests; prints the map and writes it as Markdown", async () => {
    const dir = appWith('token: "gc_AbCdEfGhIjKlMnOpQrStUv", telemetry: false', { "tests/app.spec.ts": 'import "@genclass/runtime/auto/guard"; // a test only' });
    const s = await readSetup({ cwd: dir });
    expect(s.installed).toBe(true);
    expect(s.files.sort()).toEqual(["src/genclass.config.ts", "src/main.jsx"]);
    expect(s).toMatchObject({ mode: "observe", telemetry: "off", token: true, app: "shop" });
    let code = -1;
    const said = await printed(async () => (code = await privacy({ cwd: dir })));
    expect(code).toBe(0);
    expect(said).toContain("Not legal advice.");
    expect(said).toContain("What leaves your visitors' browsers");
    expect(said).not.toContain("genclass.dev (GenClass's collector");
    const out = join(dir, "privacy.md");
    await printed(async () => expect(await privacy({ cwd: dir, out })).toBe(0));
    const md = readFileSync(out, "utf8");
    expect(md).toMatch(/^# GenClass in shop: what it sends and keeps/);
    expect(md).toContain("| Diagnostics | off |");
    expect(md).toContain("## What stays on the visitor's device");
    expect(markdown(s as any, dataMap(s as any), "2026-11-13")).toContain("on 2026-11-13");
  });

  it("a project without GenClass: the defaults, said as such, and exit code 1", async () => {
    const dir = tempDir();
    viteApp(dir);
    let code = -1;
    const said = await printed(async () => (code = await privacy({ cwd: dir })));
    expect(code).toBe(1);
    expect(said.replace(/\s+/g, " ")).toContain("GenClass is not in this project's files yet. This is what the defaults do once it is added.");
    const j = JSON.parse(await printed(async () => privacy({ cwd: dir, json: true })));
    expect(j.setup.installed).toBe(false);
    expect(j.sent[0].to).toMatch(/^genclass\.dev/);
  });
});

/** dataMap of a setup read from text (one file's, or several), with a token and as installed. */
const mapOf = (text: string | string[], over: Record<string, unknown> = {}) => {
  const s = { ...readSetupText(text), token: true, files: [], installed: true, app: "shop", ...over } as any;
  return { s, m: dataMap(s) };
};
const TEMPLATES = new URL("../../../templates/", import.meta.url);

describe("genclass privacy: options read from GenClass's own places only, each in its own object (src/privacy.mjs)", () => {
  it("another library's endpoint, baseUrl or telemetry keys in the entry file are not GenClass's (findings 1, 35)", async () => {
    const entry = 'import "@genclass/runtime/auto";\nAmplify.configure({ API: { GraphQL: { endpoint: "https://abc.appsync-api.us-east-1.amazonaws.com/graphql" } } });\nconst api = createClient({ baseUrl: "https://api.example.com" });\nconst chart = { telemetry: false, analytics: true, model: false, mode: "guard", sample: 0.5, learn: { persist: true } };\n';
    expect(readSetupText(entry)).toMatchObject({ mode: "observe", telemetry: "on", endpoint: null, analytics: false, model: "cdn", modelHost: null, sampled: false, learn: "none" });
    // a real project: init's lines and the app's own client in the same file
    const dir = appWith('token: "gc_AbCdEfGhIjKlMnOpQrStUv"', { "src/main.jsx": `${INIT_ENTRY}${entry.split("\n").slice(1).join("\n")}` });
    const s = await readSetup({ cwd: dir });
    const m = dataMap(s);
    expect(m.sent.map((x) => x.to.split(" ")[0])).toEqual(["genclass.dev", "cdn.jsdelivr.net"]);
    expect(m.csp).toContain("connect-src https://genclass.dev");
    expect(JSON.stringify(m)).not.toContain("appsync");
    expect(JSON.stringify(m)).not.toContain("api.example.com");
    // GenClass's own endpoint, inside telemetry: { ... }, still counts
    expect(readSetupText('GenClass.init({ telemetry: { sample: 0.5, endpoint: "https://collect.shop.example/v1" } })')).toMatchObject({ telemetry: "own", endpoint: "collect.shop.example" });
  });

  it("Nuxt and Astro setups count, with the options their modules pass on (findings 2, 5)", async () => {
    const nuxt = tempDir();
    write(nuxt, {
      "package.json": JSON.stringify({ name: "shop", private: true, type: "module", dependencies: { nuxt: "^4.0.0", "@genclass/nuxt": "^0.1.0" } }),
      "nuxt.config.ts": 'export default defineNuxtConfig({\n  modules: ["@genclass/nuxt"],\n  genclass: { mode: "guard", telemetry: false, model: false },\n  devtools: { enabled: false },\n});\n',
    });
    const n = await readSetup({ cwd: nuxt });
    // the module reads mode, token and telemetry only: model: false never reaches the runtime
    expect(n).toMatchObject({ installed: true, files: ["nuxt.config.ts"], mode: "guard", telemetry: "off", model: "cdn" });
    expect(await printed(async () => expect(await privacy({ cwd: nuxt })).toBe(0))).not.toContain("not in this project's files yet");
    expect(readSetupText('export default defineNuxtConfig({ modules: [["@genclass/nuxt", { mode: "guard" }]] })').mode).toBe("guard");
    const astro = tempDir();
    write(astro, {
      "package.json": JSON.stringify({ name: "site", private: true, type: "module", dependencies: { astro: "^5.0.0", "@genclass/astro": "^0.1.0" } }),
      "astro.config.mjs": 'import gc from "@genclass/astro";\nimport { defineConfig } from "astro/config";\n\nexport default defineConfig({ integrations: [gc({ mode: "guard", telemetry: false })] });\n',
    });
    expect(await readSetup({ cwd: astro })).toMatchObject({ installed: true, files: ["astro.config.mjs"], mode: "guard", telemetry: "off" });
    // the shipped templates: the defaults, as installed
    for (const t of ["nuxt", "astro"]) expect(await readSetup({ cwd: new URL(`${t}/`, TEMPLATES).pathname })).toMatchObject({ installed: true, mode: "observe", telemetry: "on" });
  });

  it("learn.persist and breaker.persist are separate; telemetry.sample is not the session sample (findings 9, 36)", () => {
    const { s, m } = mapOf('GenClass.init({ mode: "guard", learn: { expectations: true }, breaker: { persist: false } })');
    expect(s).toMatchObject({ learn: "local", breaker: "memory" });
    expect(m.kept.map((x) => x.where)).toEqual(["localStorage (genclass:learn) and sessionStorage (genclass:learn:session)", "Cache Storage"]);
    expect(readSetupText('GenClass.init({ breaker: { persist: "session" } })').learn).toBe("none");
    expect(mapOf('GenClass.init({ mode: "heal", breaker: false })').m.kept.map((x) => x.where)).toEqual(["Cache Storage"]);
    expect(mapOf('GenClass.init({ mode: "guard" })').m.kept.map((x) => x.where)).toEqual(["sessionStorage (genclass:breaker)", "Cache Storage"]);
    expect(readSetupText("GenClass.init({ telemetry: { sample: 0.1 } })").sampled).toBe(false);
    expect(mapOf("GenClass.init({ sample: 0.5 })").m.kept.map((x) => x.where)).toContain("sessionStorage (genclass:bucket)");
    // a learn.key rename names both entries
    expect(mapOf('GenClass.init({ learn: { persist: true, key: "shop:learn" } })').m.kept[0]!.where).toBe("localStorage (shop:learn) and sessionStorage (shop:learn:session)");
  });

  it("the Setup row 'Stored on the device' is the same list as the device section (findings 26, 83)", () => {
    const d = mapOf('import "@genclass/runtime/auto";');
    expect(markdown(d.s, d.m, "2026-11-14")).toContain("| Stored on the device | the model's files in Cache Storage |");
    const g = mapOf('import "@genclass/runtime/auto/guard";');
    expect(markdown(g.s, g.m, "2026-11-14")).toContain("| Stored on the device | the safety breaker's state in sessionStorage, the model's files in Cache Storage |");
    const off = mapOf("GenClass.init({ model: false, telemetry: false })");
    expect(markdown(off.s, off.m, "2026-11-14")).toContain("| Stored on the device | nothing |");
    expect(d.m.kept[0]!.what).toContain("ONNX Runtime's wasm");
    expect(mapOf("GENCLASS_CONFIG = { learn: { expectations: true } }").m.strict.find(([o]) => o.startsWith("learn"))![1]).toBe("no learned state is kept on the device");
  });

  it("the self-host command names the folder the framework serves: static/ on SvelteKit (finding 27)", async () => {
    const dir = tempDir();
    write(dir, {
      "package.json": JSON.stringify({ name: "kit", private: true, type: "module", devDependencies: { "@sveltejs/kit": "^2.0.0", svelte: "^5.0.0", vite: "^8.0.0" } }),
      "svelte.config.js": "export default {};\n",
      "src/hooks.client.ts": 'import "@genclass/runtime/auto"; // genclass:init\n',
    });
    const s = await readSetup({ cwd: dir });
    expect(s.publicDir).toBe("static");
    expect(dataMap(s).strict.find(([o]) => o.startsWith("model"))![2]).toBe("npx @genclass/runtime@beta fetch-model static/genclass-model");
    expect(mapOf('import "@genclass/runtime/auto";').m.strict.find(([o]) => o.startsWith("model"))![2]).toBe("npx @genclass/runtime@beta fetch-model public/genclass-model");
  });

  it('the EU fallback "no recipient to disclose" only when nothing leaves the browser (finding 30)', () => {
    const own = mapOf('GenClass.init({ telemetry: { endpoint: "https://collector.vendor.io/v1" }, model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" } })');
    expect(own.m.sent.map((x) => x.to)).toEqual(["collector.vendor.io (your own collector: telemetry.endpoint)"]);
    expect(own.m.eu.join(" ")).not.toContain("no recipient to disclose");
    expect(own.m.eu.join(" ")).toContain("Diagnostics go to your own collector (collector.vendor.io)");
    const sink = mapOf('GenClass.init({ telemetry: false, model: false, sinks: ["webhook:https://hooks.example.com/x"] })');
    expect(sink.m.eu.join(" ")).not.toContain("no recipient to disclose");
    expect(sink.m.eu.join(" ")).toContain("hooks.example.com");
    const other = mapOf('GenClass.init({ telemetry: false, model: { baseUrl: "https://models.example.com/m/", ortWasmPaths: "https://models.example.com/ort/" } })');
    expect(other.m.sent.map((x) => x.to)).toEqual(["models.example.com (model.baseUrl and ortWasmPaths)"]);
    expect(other.m.eu.join(" ")).toContain("downloaded from models.example.com");
    expect(other.m.eu.join(" ")).not.toContain("no recipient to disclose");
  });

  it("a script tag on a CDN names the CDN as a recipient, with its CSP line; a self-hosted tag does not (finding 31)", () => {
    const cdn = mapOf('<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.6/dist/genclass.global.min.js" data-telemetry="off" data-model="off"></script>', { token: false });
    expect(cdn.s.script).toMatchObject({ host: "cdn.jsdelivr.net", version: "0.3.0-beta.6" });
    expect(cdn.m.sent.map((x) => x.to)).toEqual(["cdn.jsdelivr.net (a public CDN serving GenClass's script tag)"]);
    expect(cdn.m.sent[0]!.what).toContain("IP address and user agent");
    expect(cdn.m.csp).toEqual(["script-src https://cdn.jsdelivr.net"]);
    expect(cdn.m.eu.join(" ")).not.toContain("no recipient to disclose");
    const self = mapOf('<script src="/genclass/genclass.global.min.js" data-telemetry="off" data-model="off"></script>', { token: false });
    expect(self.m.sent).toEqual([]);
    expect(self.m.eu[0]).toContain("there is no recipient to disclose");
  });

  it("model.baseUrl without ortWasmPaths still fetches ONNX Runtime's wasm from jsDelivr (finding 32)", () => {
    const { s, m } = mapOf('GenClass.init({ telemetry: false, model: { baseUrl: "/genclass-model/" } })');
    expect(s).toMatchObject({ model: "self", ort: "cdn" });
    expect(m.sent.map((x) => x.to)).toEqual(["cdn.jsdelivr.net (a public CDN)"]);
    expect(m.sent[0]!.what).toContain("ONNX Runtime's wasm");
    expect(m.csp).toContain("connect-src https://cdn.jsdelivr.net");
    expect(markdown(s, m, "2026-11-14")).toContain("| Model | from your own site; ONNX Runtime's wasm from cdn.jsdelivr.net (no model.ortWasmPaths) |");
    // the tag's data-ort and the meta tag's ort= count too
    expect(readSetupText('<script src="/g/genclass.global.min.js" data-model="/genclass-model/" data-ort="/genclass-model/ort/"></script>')).toMatchObject({ model: "self", ort: "self" });
    expect(readSetupText('<meta name="genclass" content="model=/genclass-model/, ort=/genclass-model/ort/">')).toMatchObject({ model: "self", ort: "self" });
  });

  it("commented-out text is not read: the templates observe, a commented opt-out is not an opt-out (finding 33)", () => {
    for (const f of ["react-vite/src/main.tsx", "nextjs/instrumentation-client.ts", "sveltekit/src/hooks.client.ts", "vue-vite/src/main.ts", "angular/src/main.ts", "react-router/app/entry.client.tsx"]) {
      const s = readSetupText(readFileSync(new URL(f, TEMPLATES), "utf8"));
      expect([f, s.mode]).toEqual([f, "observe"]);
      expect(dataMap({ ...s, token: false, files: [], installed: true } as any).kept.map((x) => x.where)).toEqual(["Cache Storage"]);
    }
    expect(readSetupText('globalThis.GENCLASS_CONFIG = {\n  token: "gc_abc",\n  // telemetry: false,\n};').telemetry).toBe("on");
    expect(readSetupText("GenClass.init({ /* telemetry: false, */ mode: 'observe' })").telemetry).toBe("on");
    expect(readSetupText('<!-- <meta name="genclass" content="telemetry=off"> -->\n<script src="/g/genclass.global.min.js"></script>').telemetry).toBe("on");
    // a // inside a string or a URL stays
    expect(readSetupText('GenClass.init({ telemetry: { endpoint: "https://collect.example/v1" } }) // note').endpoint).toBe("collect.example");
    expect(stripComments('const re = /https?:\\/\\//; x = "a//b"; // gone')).toBe('const re = /https?:\\/\\//; x = "a//b"; ');
  });

  it("test setup files, Cypress and Playwright folders never count, on any platform (findings 34, 50)", async () => {
    const quiet = "globalThis.GENCLASS_CONFIG = { telemetry: false, model: false };\n";
    const dir = appWith('token: "gc_AbCdEfGhIjKlMnOpQrStUv"', {
      "vitest.setup.ts": quiet,
      "src/setupTests.ts": quiet,
      "jest.setup.js": quiet,
      "cypress/component/Cart.cy.tsx": quiet,
      "playwright/fixtures.ts": quiet,
      "e2e/fixtures.ts": quiet,
      "spec/genclass_spec.js": quiet,
    });
    const s = await readSetup({ cwd: dir });
    expect(s.files.sort()).toEqual(["src/genclass.config.ts", "src/main.jsx"]);
    expect(s).toMatchObject({ telemetry: "on", model: "cdn" });
    for (const p of ["e2e\\fixtures.ts", "src\\tests\\a.ts", "__mocks__\\genclass.ts", "fixtures\\app.ts"]) expect([p, isTestFile(p)]).toEqual([p, true]);
    for (const p of ["src/main.tsx", "src\\genclass.config.ts", "src/latest/app.ts"]) expect([p, isTestFile(p)]).toEqual([p, false]);
  });

  it("webhook sinks from the adapter, a same-origin path, the meta tag or code are recipients (finding 37)", () => {
    const adapter = mapOf('import { webhook } from "@genclass/runtime/sinks/webhook";\nGenClass.init({ telemetry: false, model: false, sinks: [webhook({ url: "https://hooks.example.com/genclass" })] });');
    expect(adapter.s.sinks).toEqual(["hooks.example.com"]);
    expect(adapter.m.csp).toEqual(["connect-src https://hooks.example.com"]);
    const named = mapOf('import { webhook } from "@genclass/runtime/sinks/webhook";\nconst hook = webhook({ url: "https://h.example/x" });\nGenClass.init({ telemetry: false, model: false, sinks: [hook] });');
    expect(named.s).toMatchObject({ sinks: ["h.example"], sinkCode: 0 });
    const path = mapOf('GENCLASS_CONFIG = { telemetry: false, model: false, sinks: ["webhook:/genclass"] }');
    expect(path.m.sent.map((x) => x.to)).toEqual(["your own site, /genclass (a webhook sink)"]);
    expect(path.m.eu.join(" ")).not.toContain("GenClass sends nothing from the visitor's browser and");
    expect(readSetupText('<meta name="genclass" content="sink=console-json+webhook:/g">').sinkPaths).toEqual(["/g"]);
    const custom = mapOf("GenClass.init({ telemetry: false, model: false, sinks: [{ send(r) { navigator.sendBeacon(u, r) } }] })");
    expect(custom.m.sent.map((x) => x.to)).toEqual(["a sink set up in code (its recipient is not read from the files)"]);
  });

  it("the opt-outs say what they stop: diagnostics and analytics, not sinks, the model or storage (finding 38)", () => {
    const { m } = mapOf(['import "@genclass/runtime/auto/guard";', 'GENCLASS_CONFIG = { sinks: ["webhook:https://hooks.example.com/x"] }']);
    expect(m.optOuts[0]).toContain("no diagnostics or analytics are sent from that browser");
    expect(m.optOuts[0]).toContain("webhook sinks still post findings");
    expect(m.optOuts[0]).toContain("the model still downloads from cdn.jsdelivr.net");
    expect(m.optOuts.join(" ")).not.toContain("nothing is collected");
    const pending = mapOf('GENCLASS_CONFIG = { consent: "pending" }');
    expect(pending.m.eu[0]).toContain("still wins over a grant of diagnostics or analytics");
  });

  it("consent as an object: the parts it grants run at start, the rest wait (finding 39)", () => {
    const { s, m } = mapOf('GENCLASS_CONFIG = { consent: { model: true }, model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" } }');
    expect(s.consentParts).toEqual({ diagnostics: "pending", analytics: "pending", storage: "pending", model: "granted" });
    expect(m.kept.find((x) => x.where === "Cache Storage")!.what).not.toContain("Only after");
    expect(m.sent[0]!.why).toContain("Only after the visitor grants diagnostics (the consent option leaves it pending");
    expect(m.eu[0]).toContain("the model granted");
    expect(markdown(s, m, "2026-11-14")).toContain("| Consent | per part (the consent option): diagnostics pending, analytics pending, storage pending, the model granted at start");
    // a CDN model granted at start: jsDelivr is named as a recipient, not "once the visitor grants the model"
    const cdn = mapOf("GENCLASS_CONFIG = { consent: { model: true } }");
    expect(cdn.m.eu.join(" ")).toContain("comes from jsDelivr");
    expect(cdn.m.eu.join(" ")).not.toContain("Once the visitor grants the model");
  });

  it("the consent gate is described as working only where the project's runtime has it (finding 7)", async () => {
    // a runtime without the gate (0.3.0-beta.6 from npm): the option is ignored, and the map says so
    const old = appWith('token: "gc_AbCdEfGhIjKlMnOpQrStUv", consent: "pending"', { "node_modules/@genclass/runtime/package.json": JSON.stringify({ name: "@genclass/runtime", version: "0.3.0-beta.6" }) });
    const s = await readSetup({ cwd: old });
    expect(s).toMatchObject({ consent: "pending", runtimeVersion: "0.3.0-beta.6", consentSupported: false });
    const m = dataMap(s);
    expect(m.sent[0]!.why).not.toContain("Only after");
    expect(m.eu[0]).toContain("has no consent gate: it ignores the option");
    expect(m.strict.map(([o]) => o)).not.toContain('consent: "pending"');
    expect(markdown(s, m, "2026-11-14")).toContain('| Consent | set (consent: "pending"), but @genclass/runtime 0.3.0-beta.6 here has no consent gate and ignores it');
    // without the option, it is not recommended either on that runtime
    const plain = await readSetup({ cwd: appWith(undefined, { "node_modules/@genclass/runtime/package.json": JSON.stringify({ name: "@genclass/runtime", version: "0.3.0-beta.6" }) }) });
    expect(dataMap(plain).strict.map(([o]) => o)).not.toContain('consent: "pending"');
    expect(dataMap(plain).eu[0]).toContain("The careful choice for EU, EEA and UK visitors is telemetry off");
    // a build with the gate (this line's dist has the consent chunk): described as working
    const built = appWith('consent: "pending"', { "node_modules/@genclass/runtime/package.json": JSON.stringify({ name: "@genclass/runtime", version: "0.3.0-beta.6" }), "node_modules/@genclass/runtime/dist/consent-AB12CD34.js": "export {};\n" });
    const b = await readSetup({ cwd: built });
    expect(b.consentSupported).toBe(true);
    expect(dataMap(b).sent[0]!.why).toContain("Only after the visitor grants diagnostics");
    // no runtime found: not known, and said
    const none = await readSetup({ cwd: appWith('consent: "pending"') });
    expect(none.consentSupported).toBeNull();
    expect(dataMap(none).eu.join(" ")).toContain("0.3.0-beta.6 and earlier ignore the option");
    expect(markdown(none, dataMap(none), "2026-11-14")).toContain("whether the runtime here has the gate is not known");
    // a script tag runs the version in its URL
    expect(runtimeOf(tempDir(), { host: "cdn.jsdelivr.net", version: "0.3.0-beta.6" })).toMatchObject({ consent: false, source: "script tag" });
    expect(runtimeOf(tempDir(), { host: "cdn.jsdelivr.net", version: null })).toMatchObject({ consent: null });
  });

  it("the npx form of the --out command, until genclass is installed (finding 75)", async () => {
    const said = await printed(async () => privacy({ cwd: appWith() }));
    expect(said.replace(/\s+/g, " ")).toContain("npx genclass privacy --out genclass-privacy.md");
  });

  it('consent: "pending" and "denied" say what still runs: the off-switch read, sinks, the script tag (finding 81)', () => {
    const p = mapOf('GENCLASS_CONFIG = { consent: "pending", sinks: ["webhook:https://hooks.example.com/x"] }');
    expect(p.m.eu[0]).not.toContain("reads or writes none of its own storage entries");
    expect(p.m.eu[0]).toContain('of its own storage it only reads its off switch, localStorage "genclass"');
    expect(p.m.eu[0]).toContain("Your webhook sinks are not gated");
    expect(markdown(p.s, p.m, "2026-11-14")).toContain("; your webhook sinks still send");
    const d = mapOf('<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.4.0/dist/genclass.global.min.js" data-consent="denied"></script>');
    expect(d.m.eu[0]).toContain("nothing of its own");
    expect(d.m.eu[0]).toContain("GenClass's script itself, and the parts it loads that the gate does not hold, still come from cdn.jsdelivr.net");
    // the coding-agent link is not gated either (development builds only)
    expect(mapOf('GENCLASS_CONFIG = { consent: "pending" }; connectAgent(GenClass.init());').m.eu[0]).toContain("The coding-agent link still runs in development builds");
  });

  it("the analytics visit entry has no expiry (finding 82)", () => {
    const what = mapOf("GENCLASS_CONFIG = { analytics: true }").m.kept.find((x) => x.where.startsWith("localStorage (genclass.analytics"))!.what;
    expect(what).toContain("One entry with no expiry");
    expect(what).not.toContain("for 30 minutes");
  });

  it("IP addresses and user agents: never stored by GenClass, but every recipient receives them (finding 84)", () => {
    const { s, m } = mapOf('import "@genclass/runtime/auto";');
    const md = markdown(s, m, "2026-11-14");
    expect(md).not.toContain("IP addresses or user agents (the collector does not store them)");
    expect(md).toContain("Every server the browser contacts (each recipient above) receives the visitor's IP address and user agent");
  });

  it("with an app key, genclass.dev's row names its onward recipients (finding 85)", () => {
    const keyed = mapOf('import "@genclass/runtime/auto";').m.sent[0]!.why;
    expect(keyed).toContain("Sentry, PostHog, Datadog, Slack or a webhook");
    expect(keyed).toContain("OpenAI's API");
    expect(mapOf('import "@genclass/runtime/auto";', { token: false }).m.sent[0]!.why).not.toContain("OpenAI");
  });

  it("options set by code are named as not read", () => {
    const { s, m } = mapOf("GenClass.init({ telemetry: import.meta.env.PROD ? {} : false, mode })");
    expect(s.unread).toEqual(["mode", "telemetry"]);
    expect(markdown(s, m, "2026-11-14")).toContain("| Not read | mode and telemetry: set by code");
  });
});

describe("genclass privacy: read as the runtime reads it, so the map never says less is sent (src/privacy.mjs)", () => {
  it("a telemetry.endpoint that is not an http(s) URL sends to genclass.dev, as the runtime takes it (telemetry/config.ts)", async () => {
    for (const ep of ['"/collect"', '"//collector.example/v1"', '"collector.example/v1"', '" https://collect.example/v1"', "import.meta.env.VITE_COLLECTOR"]) {
      const { s, m } = mapOf(`GenClass.init({ telemetry: { endpoint: ${ep} } })`);
      expect([ep, s.telemetry, s.endpoint]).toEqual([ep, "on", null]);
      expect([ep, m.sent[0]!.to]).toEqual([ep, "genclass.dev (GenClass's collector, a Cloudflare Worker; stored in Cloudflare R2)"]);
      expect(m.csp).toContain("connect-src https://genclass.dev");
      expect(m.us.join(" ")).toContain("service-provider contract");
      expect(JSON.stringify(m)).not.toContain("your own collector");
    }
    // one set by code may be genclass.dev too, and is named as not read
    expect(readSetupText("GenClass.init({ telemetry: { endpoint: import.meta.env.VITE_COLLECTOR } })").unread).toEqual(["telemetry.endpoint"]);
    // an http(s) URL, in any case, is the app's own collector
    expect(readSetupText('GenClass.init({ telemetry: { endpoint: "HTTP://collect.example:8080/v1" } })')).toMatchObject({ telemetry: "own", endpoint: "collect.example:8080" });
    // doctor's Diagnostics row says the same (it printed "to your own collector (null)")
    const dir = appWith('telemetry: { endpoint: "/collect" }');
    const list = await checks({ cwd: dir }, { offline: true, pathVersion: null, creds: null, listening: async () => false });
    expect(list.find((x: any) => x.id === "privacy").detail).toBe("on: anonymous counts to genclass.dev from public hosts");
  });

  it("window.GENCLASS_CONFIG is read only from a whole literal that certainly applies; every other way is named, with the reading that sends more", () => {
    const IMPORT = 'import "@genclass/runtime/auto";';
    // a literal at the top level of its own file (or of a script before the tag), on window, globalThis, window["..."]
    for (const src of [
      "window.GENCLASS_CONFIG = { telemetry: false };",
      'window["GENCLASS_CONFIG"] = { telemetry: false };',
      "(globalThis as { GENCLASS_CONFIG?: object }).GENCLASS_CONFIG = { telemetry: false } as const;",
      "const a = 1\nif (b) start()\nwindow.GENCLASS_CONFIG = { telemetry: false }",
      "window.GENCLASS_CONFIG = { telemetry: false }\nObject.assign(window, { a: 1 })\ndeclare global { interface Window { GENCLASS_CONFIG: object } }",
      // a later whole literal replaces what came before it in the same script
      "window.GENCLASS_CONFIG ??= { model: false };\nwindow.GENCLASS_CONFIG.mode = 'heal';\nwindow.GENCLASS_CONFIG = { telemetry: false };",
    ])
      expect([src, readSetupText([IMPORT, src])]).toMatchObject([src, { telemetry: "off", model: "cdn", mode: "observe", unread: [] }]);
    expect(readSetupText('<script>window.GENCLASS_CONFIG = { telemetry: false }</script><script src="/g/genclass.global.min.js"></script>')).toMatchObject({ telemetry: "off", unread: [] });
    // a key after a spread is certain; the spread is named
    expect(readSetupText([IMPORT, "window.GENCLASS_CONFIG = { ...window.GENCLASS_CONFIG, telemetry: false };"])).toMatchObject({ telemetry: "off", unread: ["options spread in from code (...window.GENCLASS_CONFIG)"] });
    // a default, Object.assign, an identifier, code, one key set on its own: named, and telemetry stays on
    for (const [src, name] of [
      ["window.GENCLASS_CONFIG ||= { telemetry: false };", "window.GENCLASS_CONFIG"],
      ["window.GENCLASS_CONFIG ??= { telemetry: false };", "window.GENCLASS_CONFIG"],
      ["const config = { telemetry: false };\nwindow.GENCLASS_CONFIG = config;", "window.GENCLASS_CONFIG"],
      ["window.GENCLASS_CONFIG = Object.assign(window.GENCLASS_CONFIG || {}, { telemetry: false });", "window.GENCLASS_CONFIG"],
      ["Object.assign(window.GENCLASS_CONFIG, { telemetry: false });", "window.GENCLASS_CONFIG"],
      ["window.GENCLASS_CONFIG = window.GENCLASS_CONFIG || { telemetry: false };", "window.GENCLASS_CONFIG"],
      ["window.GENCLASS_CONFIG.telemetry = false;\nstart();", "window.GENCLASS_CONFIG.telemetry"],
      ["window.GENCLASS_CONFIG = makeConfig();", "window.GENCLASS_CONFIG"],
      ["window.GENCLASS_CONFIG &&= { telemetry: false };", "window.GENCLASS_CONFIG"],
      ['window.GENCLASS_CONFIG.telemetry.endpoint = "https://c.example/v1";', "window.GENCLASS_CONFIG.telemetry.endpoint"],
      ["window.GENCLASS_CONFIG = Object.assign(window.GENCLASS_CONFIG || {}, defaults());", "window.GENCLASS_CONFIG"],
      ["delete window.GENCLASS_CONFIG.telemetry;", "window.GENCLASS_CONFIG.telemetry"],
      ['Object.defineProperty(window, "GENCLASS_CONFIG", { value: { telemetry: false } });', "window.GENCLASS_CONFIG"],
      ["Object.assign(window, { GENCLASS_CONFIG: { telemetry: false } });", "window.GENCLASS_CONFIG"],
    ])
      expect([src, readSetupText([IMPORT, src])]).toMatchObject([src, { telemetry: "on", unread: [name] }]);
    // where every way says the same, that is the reading
    expect(readSetupText([IMPORT, "window.GENCLASS_CONFIG = { telemetry: false };\nif (dnt) window.GENCLASS_CONFIG.telemetry = false;"])).toMatchObject({ telemetry: "off" });
    // a sink added by code is a recipient set up in code
    const pushed = mapOf([IMPORT, "window.GENCLASS_CONFIG = { telemetry: false, model: false };\nwindow.GENCLASS_CONFIG.sinks.push(hook);"]);
    expect(pushed.s).toMatchObject({ telemetry: "off", sinkCode: 1, unread: ["window.GENCLASS_CONFIG.sinks"] });
    expect(pushed.m.sent.map((x) => x.to)).toEqual(["a sink set up in code (its recipient is not read from the files)"]);
    // a default (??=) never applies beside an assignment of a whole new object
    expect(readSetupText('window.GENCLASS_CONFIG ??= { telemetry: false };\nwindow.GENCLASS_CONFIG = { token: "gc_AbCdEfGhIjKlMnOpQrStUv" };')).toMatchObject({ telemetry: "on", tokenInOptions: true });
    // what a not-read write turns on stays on (analytics as the text says), and an acting mode counts
    expect(readSetupText('window.GENCLASS_CONFIG ??= { telemetry: false };\nwindow.GENCLASS_CONFIG.mode = "guard";')).toMatchObject({ telemetry: "on", mode: "guard" });
    expect(readSetupText("window.GENCLASS_CONFIG = { telemetry: false };\nObject.assign(window.GENCLASS_CONFIG, { analytics: true });")).toMatchObject({ telemetry: "off", analytics: true });
    // comparisons and type declarations are not assignments
    expect(readSetupText("if (window.GENCLASS_CONFIG == null) start(window.GENCLASS_CONFIG === x);\ndeclare global { interface Window { GENCLASS_CONFIG?: object } }")).toMatchObject({ telemetry: "on", unread: [] });
  });

  it("createRuntime({...}) is read with createRuntime's defaults: no diagnostics, model or visual checks unless set (API.md)", async () => {
    const IMPORT = 'import { createRuntime } from "@genclass/runtime";\n';
    const quiet = mapOf(`${IMPORT}export const rt = createRuntime({ telemetry: false, model: false });`, { token: false });
    expect(quiet.s).toMatchObject({ headless: true, telemetry: "off", model: "off", visual: "off", unread: [] });
    expect(quiet.m.sent).toEqual([]);
    expect(quiet.m.kept).toEqual([]);
    expect(markdown(quiet.s, quiet.m, "2026-11-14")).toContain("| Runtime | createRuntime(...) only (headless use)");
    expect(readSetupText(`${IMPORT}createRuntime();`)).toMatchObject({ telemetry: "off", model: "off" });
    // what its options turn on is listed, through any name the import gives it
    expect(readSetupText('import * as gc from "@genclass/runtime";\ngc.createRuntime({ telemetry: {}, model: {} });')).toMatchObject({ headless: true, telemetry: "on", model: "cdn" });
    expect(readSetupText('const { createRuntime: make } = require("@genclass/runtime");\nmake({ telemetry: true });')).toMatchObject({ headless: true, telemetry: "on", model: "off" });
    // options it cannot read: the defaults of GenClass.init, which send more, and a Not read row
    expect(readSetupText('import { createRuntime as make } from "@genclass/runtime";\nmake(options());')).toMatchObject({ headless: false, telemetry: "on", model: "cdn", unread: ["the options passed to createRuntime(...)"] });
    // beside GenClass.init it is a second runtime: the map is init's, and a createRuntime that sends is named
    const both = 'import { GenClass, createRuntime } from "@genclass/runtime";\nGenClass.init({ telemetry: false });\n';
    expect(readSetupText(`${both}createRuntime({ decider });`)).toMatchObject({ headless: false, telemetry: "off", unread: [] });
    expect(readSetupText(`${both}createRuntime({ telemetry: true });`)).toMatchObject({ telemetry: "off", unread: ["the options passed to createRuntime(...) (a second runtime, besides GenClass.init's)"] });
    // another library's createRuntime is not GenClass's
    expect(readSetupText('import { createRuntime } from "other-lib";\nimport "@genclass/runtime/auto";\ncreateRuntime({ telemetry: false });')).toMatchObject({ headless: false, telemetry: "on" });
    // a real project
    const dir = tempDir();
    viteApp(dir);
    write(dir, { "src/genclass.ts": `${IMPORT}export const rt = createRuntime({ telemetry: false, model: false });\n` });
    expect(await readSetup({ cwd: dir })).toMatchObject({ installed: true, files: ["src/genclass.ts"], headless: true, telemetry: "off", model: "off" });
  });

  it("a regular expression literal in the options does not cut them short", () => {
    for (const re of ["/\\/a\\(x/", "/[(]/", '/"quote/', "/'q/i", "/[}\\]]/"]) {
      const src = `GenClass.init({ requests: { protect: [${re}] }, telemetry: false, model: false })`;
      expect([src, readSetupText(src)]).toMatchObject([src, { telemetry: "off", model: "off", unread: [] }]);
    }
    expect(readSetupText("GenClass.init({ protect: [(u) => /\\/pay\\(/.test(u)], telemetry: false })").telemetry).toBe("off");
    // a division is not a regular expression
    expect(readSetupText("GenClass.init({ sample: total / 2, flushMs: (a) / 3, telemetry: false })")).toMatchObject({ telemetry: "off" });
  });

  it("data-consent and consent= in the meta tag fail closed, as the runtime reads them: denied, or pending for any other value", () => {
    const tag = (attr: string) => `<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.4.0/dist/genclass.global.min.js" ${attr}></script>`;
    for (const attr of ["data-consent", 'data-consent="granted"', 'data-consent="true"', 'data-consent="pendng"', 'data-consent="pending"']) expect([attr, readSetupText(tag(attr)).consent]).toEqual([attr, "pending"]);
    expect(readSetupText(tag('data-consent="denied"')).consent).toBe("denied");
    for (const c of ["consent", "consent=granted", "consent=yes"]) expect([c, readSetupText(`<meta name="genclass" content="${c}">`).consent]).toEqual([c, "pending"]);
    // the map says the runtime waits, not that everything starts with the page
    const { s, m } = mapOf(tag('data-consent="granted"'));
    expect(markdown(s, m, "2026-11-14")).not.toContain("| Consent | no consent gate");
    expect(m.eu[0]).toContain('GenClass waits for consent (consent: "pending")');
  });

  it("a key set inside a condition does not always apply: telemetry and the model stay on, and it is named (round 3, item 1)", () => {
    const IMPORT = 'import "@genclass/runtime/auto";';
    const dnt = mapOf([IMPORT, 'window.GENCLASS_CONFIG = { token };\nif (navigator.doNotTrack === "1") window.GENCLASS_CONFIG.telemetry = false;']);
    expect(dnt.s).toMatchObject({ telemetry: "on", unread: ["window.GENCLASS_CONFIG.telemetry (in a condition or a function)"] });
    expect(dnt.m.sent[0]!.to).toMatch(/^genclass\.dev/);
    expect(markdown(dnt.s, dnt.m, "2026-11-14")).toContain("| Not read | window.GENCLASS_CONFIG.telemetry (in a condition or a function): set by code, or not certain to apply, so for what they may set this map takes the reading that sends and keeps more |");
    expect(readSetupText([IMPORT, "window.GENCLASS_CONFIG = { telemetry: false };\nif (slow) window.GENCLASS_CONFIG.model = false;"])).toMatchObject({ telemetry: "off", model: "cdn" });
    // in a function or a ternary, too; page text the literal asked for stays on
    expect(readSetupText([IMPORT, "window.GENCLASS_CONFIG = {};\nexport function quiet() { window.GENCLASS_CONFIG.telemetry = false; }"]).telemetry).toBe("on");
    expect(readSetupText([IMPORT, "window.GENCLASS_CONFIG = {};\ndnt ? (window.GENCLASS_CONFIG.telemetry = false) : 0;"]).telemetry).toBe("on");
    expect(readSetupText([IMPORT, "window.GENCLASS_CONFIG = { telemetry: { include: { situation: true } } };\nif (x) window.GENCLASS_CONFIG.telemetry = false;"])).toMatchObject({ telemetry: "on", situation: true });
  });

  it("Object.assign(window.GENCLASS_CONFIG || {}, ...) on its own is not read as setting GENCLASS_CONFIG (round 3, item 2)", () => {
    for (const src of ["Object.assign(window.GENCLASS_CONFIG || {}, { telemetry: false });", "Object.assign(window.GENCLASS_CONFIG ?? {}, { telemetry: false });"])
      expect([src, readSetupText(['import "@genclass/runtime/auto";', src])]).toMatchObject([src, { telemetry: "on", unread: ["window.GENCLASS_CONFIG"] }]);
  });

  it("two defaults are not merged: only the first ||= that runs applies (round 3, item 3)", () => {
    expect(readSetupText(['import "@genclass/runtime/auto";', "window.GENCLASS_CONFIG ||= { telemetry: false };\nwindow.GENCLASS_CONFIG ||= { model: false };"])).toMatchObject({ telemetry: "on", model: "cdn", unread: ["window.GENCLASS_CONFIG"] });
  });

  it("an identifier given to GENCLASS_CONFIG is not looked up: a function's const, a later const, another script's (round 3, item 4)", () => {
    for (const src of [
      "function a() { const config = { telemetry: false } }\nconst config = { mode: 'guard' };\nwindow.GENCLASS_CONFIG = config;",
      "(window as any).GENCLASS_CONFIG = config as InitOptions;\nconst config = { telemetry: false };",
    ])
      expect([src, readSetupText(['import "@genclass/runtime/auto";', src])]).toMatchObject([src, { telemetry: "on", mode: "observe", unread: ["window.GENCLASS_CONFIG"] }]);
    expect(readSetupText('<script>window.GENCLASS_CONFIG = cfg</script><script>const cfg = { telemetry: false }</script><script src="/g/genclass.global.min.js"></script>')).toMatchObject({ telemetry: "on", unread: ["window.GENCLASS_CONFIG"] });
  });

  it("order: a write after a self-spread is not dropped, and a key set before a whole new object is (round 3, item 5)", () => {
    const IMPORT = 'import "@genclass/runtime/auto";';
    expect(readSetupText([IMPORT, "window.GENCLASS_CONFIG = { ...window.GENCLASS_CONFIG, mode: 'guard' };\nwindow.GENCLASS_CONFIG ??= { telemetry: false };"])).toMatchObject({ telemetry: "on", mode: "guard" });
    expect(readSetupText([IMPORT, "window.GENCLASS_CONFIG.telemetry = false;\nwindow.GENCLASS_CONFIG = { mode: 'guard' };"])).toMatchObject({ telemetry: "on", mode: "guard", unread: [] });
    // two whole literals in one script: the later one is GenClass's
    expect(readSetupText([IMPORT, "window.GENCLASS_CONFIG = { telemetry: false, analytics: true };\nwindow.GENCLASS_CONFIG = { mode: 'guard' };"])).toMatchObject({ telemetry: "on", analytics: false, mode: "guard" });
    // in two files, either may run last: what they disagree on is not read
    expect(readSetupText([IMPORT, "window.GENCLASS_CONFIG = { telemetry: false, model: false };", "window.GENCLASS_CONFIG = { model: false };"])).toMatchObject({ telemetry: "on", model: "off", unread: ["window.GENCLASS_CONFIG (set in more than one place)"] });
  });

  it("writes through ||= {}, ??= {} and TypeScript's ! are named (round 3, item 6)", () => {
    for (const [src, name] of [
      ["Object.assign(window.GENCLASS_CONFIG ||= {}, { telemetry: false });", "window.GENCLASS_CONFIG"],
      ["(window.GENCLASS_CONFIG ??= {}).telemetry = false;", "window.GENCLASS_CONFIG"],
      ["window.GENCLASS_CONFIG!.telemetry = false;", "window.GENCLASS_CONFIG.telemetry"],
      ["(window.GENCLASS_CONFIG as InitOptions).telemetry = false;", "window.GENCLASS_CONFIG.telemetry"],
    ])
      expect([src, readSetupText(['import "@genclass/runtime/auto";', src])]).toMatchObject([src, { telemetry: "on", unread: [name] }]);
  });

  it("createRuntime with a spread is not read as headless: the spread may turn telemetry and the model on (round 3, item 7)", () => {
    const IMPORT = 'import { createRuntime } from "@genclass/runtime";\n';
    for (const [src, spread] of [
      ["createRuntime({ ...window.GENCLASS_CONFIG })", "window.GENCLASS_CONFIG"],
      ["createRuntime({ ...base })", "base"],
    ])
      expect([src, readSetupText(`${IMPORT}${src}`)]).toMatchObject([src, { headless: false, telemetry: "on", model: "cdn", unread: [`options spread in from code (...${spread})`] }]);
    // a key after the spread is certain
    expect(readSetupText(`${IMPORT}createRuntime({ ...base, telemetry: false })`)).toMatchObject({ telemetry: "off", model: "cdn" });
  });

  it("GenClass.init through the default import or a namespace counts as a browser runtime (round 3, item 8)", () => {
    expect(readSetupText('import gc, { createRuntime } from "@genclass/runtime";\ngc.init({});\ncreateRuntime();')).toMatchObject({ headless: false, telemetry: "on", model: "cdn" });
    expect(readSetupText('import * as gc from "@genclass/runtime";\ngc.GenClass.init();\ngc.createRuntime();')).toMatchObject({ headless: false, telemetry: "on" });
    expect(readSetupText('import * as gc from "@genclass/runtime";\ngc.default.init();\ngc.createRuntime();')).toMatchObject({ headless: false, telemetry: "on" });
    expect(readSetupText('import { GenClass as G, createRuntime } from "@genclass/runtime";\nG.init({ telemetry: false });\ncreateRuntime();')).toMatchObject({ headless: false, telemetry: "off", model: "cdn" });
    // imported, but no init(...) call found on it: it may still start one, and that is said
    expect(readSetupText('import gc, { createRuntime } from "@genclass/runtime";\nstart(gc);\ncreateRuntime();')).toMatchObject({
      headless: false,
      telemetry: "on",
      unread: ["GenClass, imported as gc (no call of its init(...) was found, so it may start with GenClass.init's defaults)"],
    });
    // another entry's default export is not GenClass
    expect(readSetupText('import { createRuntime } from "@genclass/runtime";\nimport hook from "@genclass/runtime/sinks/webhook";\ncreateRuntime({ telemetry: false });')).toMatchObject({ headless: true, unread: [] });
  });

  it("GenClass.init(options) with an identifier is not read, in any form: the defaults, which send more, and a Not read row (round 3, item 9)", () => {
    for (const arg of ["o", "o as InitOptions", "o!"])
      expect([arg, readSetupText(`const o = { telemetry: false };\nGenClass.init(${arg});`)]).toMatchObject([arg, { telemetry: "on", model: "cdn", unread: ["the options passed to GenClass.init(...)"] }]);
  });

  it("a spread of GENCLASS_CONFIG into GenClass.init is named as not read (round 3, item 10)", () => {
    expect(readSetupText("GenClass.init({ ...window.GENCLASS_CONFIG, mode: 'guard' })")).toMatchObject({ mode: "guard", telemetry: "on", unread: ["options spread in from code (...window.GENCLASS_CONFIG)"] });
  });

  it("GENCLASS_CONFIG in the module that imports /auto is set after GenClass starts (ES imports run first)", () => {
    expect(readSetupText('import "@genclass/runtime/auto";\nwindow.GENCLASS_CONFIG = { telemetry: false };')).toMatchObject({
      telemetry: "on",
      unread: ["window.GENCLASS_CONFIG, set after the /auto import in the same module (GenClass has started by then and never reads it)"],
    });
    expect(readSetupText('window.GENCLASS_CONFIG = { telemetry: false };\nimport "@genclass/runtime/auto";')).toMatchObject({
      telemetry: "on",
      unread: ["window.GENCLASS_CONFIG (set in the module that imports @genclass/runtime/auto, whose import runs first)"],
    });
    // a require runs in place: a config set before it applies
    expect(readSetupText('window.GENCLASS_CONFIG = { telemetry: false };\nrequire("@genclass/runtime/auto");').telemetry).toBe("off");
    // its own file, or a classic script before a module: applies
    expect(readSetupText(["window.GENCLASS_CONFIG = { telemetry: false };", 'import "@genclass/runtime/auto";']).telemetry).toBe("off");
    expect(readSetupText('<script>window.GENCLASS_CONFIG = { telemetry: false }</script>\n<script type="module">import "@genclass/runtime/auto";</script>').telemetry).toBe("off");
  });

  it("GenClass.init's options are not read where GenClass already starts from /auto or the script tag, nor inside a condition or a function", () => {
    expect(readSetupText(['import "@genclass/runtime/auto";', 'import { GenClass } from "@genclass/runtime";\nGenClass.init({ telemetry: false });'])).toMatchObject({
      telemetry: "on",
      unread: ["the options passed to GenClass.init(...) (GenClass may already run from the /auto import or the script tag, which ignores a later call's options)"],
    });
    const tag = (attrs: string) => `<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.4.0/dist/genclass.global.min.js"${attrs}></script>\n<script>GenClass.init({ telemetry: false })</script>`;
    expect(readSetupText(tag("")).telemetry).toBe("on");
    expect(readSetupText(tag(" data-manual")).telemetry).toBe("off");
    for (const src of [
      "useEffect(() => { GenClass.init({ telemetry: false }) }, [])",
      "if (consented) GenClass.init({ telemetry: false })",
      "cond ? GenClass.init({ telemetry: false }) : null",
      "import.meta.env.PROD && GenClass.init({ telemetry: false })",
      "export function start() {\n  return GenClass.init({ telemetry: false });\n}",
    ])
      expect([src, readSetupText(src)]).toMatchObject([src, { telemetry: "on", unread: ["the options passed to GenClass.init(...) (in a condition or a function)"] }]);
    // at the top level it is read: in a declaration, an export, a call's arguments, after an if on its own line
    for (const src of [
      "export const rt: Runtime = GenClass.init({ telemetry: false });",
      "connectAgent(GenClass.init({ telemetry: false }));",
      "if (dev) setup()\nGenClass.init({ telemetry: false })",
      "if (dev) { setup(); }\nGenClass.init({ telemetry: false });",
    ])
      expect([src, readSetupText(src)]).toMatchObject([src, { telemetry: "off", unread: [] }]);
  });

  it("the runtime README says what still runs before consent, as the CLI's pending line does (finding 81)", () => {
    const readme = readFileSync(new URL("../../runtime/README.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    const at = readme.indexOf('Sites that ask visitors first: `consent: "pending"`');
    const para = readme.slice(at, readme.indexOf("- **Privacy policy**", at));
    expect(para).not.toContain("locally only");
    expect(para).not.toContain("no read or write of its own");
    expect(para).toContain("it only reads its off switch, `localStorage.genclass`");
    expect(para).toContain("The gate does not hold your own `sinks`");
    expect(para).toContain("the script tag and the parts it loads that the gate does not hold");
    expect(para).toContain("coding-agent link");
  });
});

describe("genclass doctor: what GenClass added, in place and current (src/doctor.mjs)", () => {
  it("compareVersions orders releases and prereleases", () => {
    expect(compareVersions("0.3.2", "0.3.8")).toBeLessThan(0);
    expect(compareVersions("0.3.0-beta.6", "0.3.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("0.3.0-beta.6", "0.3.0")).toBeLessThan(0);
    expect(compareVersions("0.4.0-alpha.0", "0.3.8")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("the entry gets one marked line importing the coding-agent link's file, right after GenClass's import (imports first, before the app's code), once, and `remove` takes it out again", () => {
    const after = withAgentLink(INIT_ENTRY)!;
    expect(after.split("\n")).toEqual([
      'import "./genclass.config"; // genclass:init',
      'import "@genclass/runtime/auto"; // genclass:init',
      'import "./genclass.agent.js"; // genclass:init',
      'import { createRoot } from "react-dom/client";',
      "",
      'createRoot(document.getElementById("root")).render(null);',
      "",
    ]);
    expect(withAgentLink(after)).toBeNull();
    // nothing of init's to put it after
    expect(withAgentLink('import { createRoot } from "react-dom/client";')).toBeNull();
    const removed = planRemoval(after);
    expect(removed.problems).toEqual([]);
    expect(removed.text).toBe('import { createRoot } from "react-dom/client";\n\ncreateRoot(document.getElementById("root")).render(null);\n');
  });

  it("importedFirst: GenClass's lines before any other import", () => {
    expect(importedFirst(INIT_ENTRY)).toBe(true);
    expect(importedFirst('import React from "react";\nimport "@genclass/runtime/auto"; // genclass:init\n')).toBe(false);
    expect(importedFirst("const x = 1;\n")).toBe(true);
  });

  it("cspGaps names what a policy blocks of what this setup needs", () => {
    const defaults = readSetupText('import "@genclass/runtime/auto";');
    expect(cspGaps("default-src 'self'; script-src 'self'", defaults).map((g) => g.need)).toEqual(["connect-src https://genclass.dev", "connect-src https://cdn.jsdelivr.net", "script-src 'wasm-unsafe-eval'"]);
    expect(cspGaps("default-src 'self'; connect-src 'self' https://genclass.dev https://cdn.jsdelivr.net; script-src 'self' 'wasm-unsafe-eval'", defaults)).toEqual([]);
    expect(cspGaps("default-src 'self'", readSetupText('telemetry: false, model: false'))).toEqual([]);
  });

  it("checks a project offline: what is wrong, with the fix; --fix writes GenClass's own lines only", async () => {
    const dir = appWith('token: "gc_AbCdEfGhIjKlMnOpQrStUv"', {
      ".mcp.json": JSON.stringify({ mcpServers: { genclass: { command: "npx", args: ["-y", "@genclass/mcp@0.1.0"] }, other: { command: "x" } } }, null, 2),
      "node_modules/@genclass/runtime/package.json": JSON.stringify({ name: "@genclass/runtime", version: "0.3.0-beta.6" }),
      "vite.config.js": "export default {};",
      "index.html": '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'">',
    });
    const deps = { offline: true, pathVersion: null, creds: null, listening: async () => false };
    const list = await checks({ cwd: dir }, deps);
    const by = Object.fromEntries(list.map((x: any) => [x.id, x]));
    expect(by.runtime).toMatchObject({ state: "ok", detail: "@genclass/runtime 0.3.0-beta.6, observe mode" });
    expect(by.order).toMatchObject({ state: "ok", detail: "first in src/main.jsx" });
    expect(by.mcp).toMatchObject({ state: "warn" });
    expect(by.mcp.detail).toContain(".mcp.json pins @genclass/mcp 0.1.0");
    expect(by.skill).toMatchObject({ state: "warn" });
    expect(by.link).toMatchObject({ state: "warn", fix: "npx genclass doctor --fix" });
    expect(by.bridge).toMatchObject({ state: "info" });
    expect(by.csp).toMatchObject({ state: "bad" });
    expect(by.csp.detail).toContain("connect-src https://genclass.dev");
    // the report, then the fixes: the pin, the skill, the link; the other server and the policy stay as they were
    let code = -1;
    const said = await printed(async () => (code = await doctor({ cwd: dir }, deps)));
    expect(code).toBe(1);
    expect(said).toContain("npx genclass doctor --fix");
    await printed(async () => expect(await doctor({ cwd: dir, fix: true, yes: true }, deps)).toBe(1));
    const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.genclass.args[1]).toMatch(/^@genclass\/mcp@\d/);
    expect(mcp.mcpServers.genclass.args[1]).not.toBe("@genclass/mcp@0.1.0");
    expect(mcp.mcpServers.other).toEqual({ command: "x" });
    expect(readFileSync(join(dir, ".claude/skills/genclass/SKILL.md"), "utf8")).toContain("genclass:init");
    expect(readFileSync(join(dir, "src/genclass.agent.js"), "utf8")).toContain("connectAgent(GenClass.init())");
    expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toContain('import "./genclass.agent.js"; // genclass:init');
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain("default-src 'self'; script-src 'self'");
    const again = Object.fromEntries((await checks({ cwd: dir }, deps)).map((x: any) => [x.id, x.state]));
    expect(again).toMatchObject({ mcp: "ok", skill: "ok", link: "ok" });
  });

  it("without a terminal and without --yes, --fix writes nothing", async () => {
    const dir = appWith();
    const before = readFileSync(join(dir, "src/main.jsx"), "utf8");
    await printed(async () => expect(await doctor({ cwd: dir, fix: true }, { offline: true, pathVersion: null, creds: null, listening: async () => false })).toBe(1));
    expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toBe(before);
  });
});

describe("the update notice (src/update.mjs)", () => {
  it("says a newer release from the last check, never in CI, piped, --json or --yes; checks npm once a day", async () => {
    const { refreshLatest, updateAllowed, updateLine } = await import("../src/update.mjs");
    expect(updateLine("0.3.8", { latestGenclass: "0.4.0" })?.text).toBe("genclass 0.4.0 is out (this is 0.3.8): npm install -g genclass@latest");
    expect(updateLine("0.4.0", { latestGenclass: "0.4.0" })).toBeNull();
    expect(updateLine("0.3.8", {})).toBeNull();
    expect(updateAllowed({}, {}, true)).toBe(true);
    expect(updateAllowed({}, { CI: "1" }, true)).toBe(false);
    expect(updateAllowed({}, {}, false)).toBe(false);
    expect(updateAllowed({ json: true }, {}, true)).toBe(false);
    expect(updateAllowed({}, { NO_UPDATE_NOTIFIER: "1" }, true)).toBe(false);
    let asked = 0;
    const fetchFn = (async () => {
      asked++;
      return new Response(JSON.stringify({ latest: "0.4.1", beta: "0.5.0-beta.0" }), { status: 200 });
    }) as unknown as typeof fetch;
    await refreshLatest(1_000_000_000_000, fetchFn, {});
    expect(asked).toBe(1);
    await refreshLatest(1_000_000_000_000, fetchFn, { latestCheckedAt: 1_000_000_000_000 - 60_000 });
    expect(asked).toBe(1);
    const { readPrefs } = await import("../src/name.mjs");
    expect(readPrefs()).toMatchObject({ latestGenclass: "0.4.1", latestCheckedAt: 1_000_000_000_000 });
  });
});

describe("genclass privacy: a higher certain value is never lost to a lower one read after it (review round 3, the WIDEN tie-break)", () => {
  const auto = 'import "@genclass/runtime/auto";';
  it("learned flows, the mode and the visual checks keep the reading that keeps more", () => {
    // two whole literals in two files: the one that keeps more stays
    expect(readSetupText([auto, "window.GENCLASS_CONFIG = { learn: { persist: true } };", "window.GENCLASS_CONFIG = { telemetry: false };"]).learn).toBe("local");
    expect(readSetupText([auto, "window.GENCLASS_CONFIG = { mode: 'heal' };", "window.GENCLASS_CONFIG = { telemetry: false };"]).mode).toBe("heal");
    // a default that never runs after a certain literal does not lower it
    const or = readSetupText([auto, "window.GENCLASS_CONFIG = { mode: 'heal', learn: { persist: true } };\nwindow.GENCLASS_CONFIG ||= { mode: 'observe', learn: { persist: false } };"]);
    expect([or.mode, or.learn]).toEqual(["heal", "local"]);
    // a deeper key written later keeps the object it is in
    expect(readSetupText([auto, 'window.GENCLASS_CONFIG = { learn: { persist: true } };\nwindow.GENCLASS_CONFIG.learn.key = "myapp";']).learn).toBe("local");
    expect(readSetupText([auto, "window.GENCLASS_CONFIG = { visual: { on: true, fix: true } };\nwindow.GENCLASS_CONFIG.visual.ignore = ['.ad'];"]).visual).toBe("on, with fixes");
  });
});
