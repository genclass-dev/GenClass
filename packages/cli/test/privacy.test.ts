// `genclass privacy` (src/privacy.mjs) and `genclass doctor` (src/doctor.mjs): what a project's setup sends and keeps,
// read from its files; and whether what GenClass added is in place, with the fixes that are GenClass's own.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planRemoval } from "../../runtime/bin/lib/edit.mjs";
import { checks, compareVersions, cspGaps, doctor, importedFirst, withAgentLink } from "../src/doctor.mjs";
import { dataMap, markdown, privacy, readSetup, readSetupText } from "../src/privacy.mjs";
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
    expect(readSetupText('import "@genclass/runtime/auto/guard"; GENCLASS_CONFIG = { telemetry: false, learn: { persist: false }, model: { baseUrl: "/genclass-model/" } }')).toMatchObject({ mode: "guard", telemetry: "off", model: "self", learn: "none" });
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
    const s = { ...readSetupText('GENCLASS_CONFIG = { telemetry: false, learn: { persist: false }, model: { baseUrl: "/genclass-model/" } }'), token: false, files: [], installed: true, app: "shop" } as any;
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
    const s = { ...readSetupText('import "@genclass/runtime/auto"; GENCLASS_CONFIG = { consent: "pending", analytics: true }'), token: true, files: [], installed: true, app: "shop" } as any;
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
    const on = dataMap({ ...readSetupText("analytics: true, include: { situation: true }"), token: true, files: [], installed: true } as any);
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

describe("genclass doctor: what GenClass added, in place and current (src/doctor.mjs)", () => {
  it("compareVersions orders releases and prereleases", () => {
    expect(compareVersions("0.3.2", "0.3.8")).toBeLessThan(0);
    expect(compareVersions("0.3.0-beta.6", "0.3.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("0.3.0-beta.6", "0.3.0")).toBeLessThan(0);
    expect(compareVersions("0.4.0-alpha.0", "0.3.8")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("the coding-agent link goes right after GenClass's import, once, and `remove` takes it out again", () => {
    const after = withAgentLink(INIT_ENTRY)!;
    expect(after.split("\n").slice(0, 7)).toEqual([
      'import "./genclass.config"; // genclass:init',
      'import "@genclass/runtime/auto"; // genclass:init',
      "// genclass:init start: the coding-agent link, development builds only: GenClass.init() returns the running runtime (genclass remove takes it out)",
      'import { GenClass } from "@genclass/runtime";',
      'import { connectAgent } from "@genclass/runtime/agent";',
      "if (import.meta.env.DEV) connectAgent(GenClass.init());",
      "// genclass:init end",
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
    expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toContain("connectAgent(GenClass.init())");
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
