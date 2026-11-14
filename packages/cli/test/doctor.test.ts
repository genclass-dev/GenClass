// `genclass doctor` (src/doctor.mjs) and the update notice (src/update.mjs): the project found the way its tools find
// it (the runtime where Node resolves it, the script tag, the agent configurations `status` reads), the site's
// Content-Security-Policy read the way a browser reads it, the skill compared without its marker, the fixes shown
// before they are written, and versions compared with the dist-tag of the line this build is on.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { skillText } from "../src/actions.mjs";
import { BUILD } from "../src/assets.mjs";
import { checks, cspGaps, cspIn, doctor, newestFor, publicDirOf, routeHasPages, sourceAllows, userPath } from "../src/doctor.mjs";
import { readSetupText } from "../src/privacy.mjs";
import { isolate, printed, tempDir, viteApp, write } from "./helpers.js";

isolate();

const INIT_ENTRY = 'import "./genclass.config"; // genclass:init\nimport "@genclass/runtime/auto"; // genclass:init\nimport { createRoot } from "react-dom/client";\n\ncreateRoot(document.getElementById("root")).render(null);\n';
const CONFIG = (opts: string) => `// genclass:init start: GenClass Runtime, added by \`npx genclass\`\n(globalThis as { GENCLASS_CONFIG?: object }).GENCLASS_CONFIG = { ${opts} };\n// genclass:init end\n`;
const RUNTIME = { "node_modules/@genclass/runtime/package.json": JSON.stringify({ name: "@genclass/runtime", version: "0.3.0-beta.6" }) };
const MCP = (v = BUILD.mcpVersion) => JSON.stringify({ mcpServers: { genclass: { command: "npx", args: ["-y", `@genclass/mcp@${v}`] } } }, null, 2);
/** Everything a correct ESM setup's policy needs. */
const GOOD = "default-src 'self'; connect-src 'self' https://genclass.dev https://cdn.jsdelivr.net; script-src 'self' 'wasm-unsafe-eval'";
const TAG = "https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.6/dist/genclass.global.min.js";
/** No network, no PATH genclass, signed out, no bridge, no repository. */
const OFF = { offline: true, pathVersion: null, creds: null, listening: async () => false, runGit: () => null };
const defaults = readSetupText('import "@genclass/runtime/auto";');
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const byId = (list: any[]) => Object.fromEntries(list.map((x) => [x.id, x]));
const channel = (v: string) => /^\d+\.\d+\.\d+-([a-z][a-z0-9-]*)/i.exec(v)?.[1] ?? null;
const RT = channel(BUILD.runtimeVersion) ? `npx @genclass/runtime@${channel(BUILD.runtimeVersion)}` : "npx @genclass/runtime";

/** A Vite app with GenClass added as init adds it (`opts` in its config file), the runtime installed, and `extra`. */
function appWith(extra: Record<string, string> = {}, opts = 'token: "gc_AbCdEfGhIjKlMnOpQrStUv"') {
  const dir = tempDir();
  viteApp(dir);
  write(dir, { "src/main.jsx": INIT_ENTRY, "src/genclass.config.ts": CONFIG(opts), "vite.config.js": "export default {};", ...RUNTIME, ...extra });
  return dir;
}

/** dist-tags as npm's registry answers them, for this command and for the runtime. */
const tagsFetch = (cli: object, rt: object = {}) => (async (url: string) => new Response(JSON.stringify(String(url).includes("runtime") ? rt : cli), { status: 200 })) as unknown as typeof fetch;

/** stdout while `fn` runs, with stderr kept out of the test's output (and returned too). */
async function both(fn: () => unknown): Promise<{ out: string; err: string }> {
  let err = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    err += String(chunk);
    return true;
  }) as never);
  try {
    const out = await printed(fn);
    return { out, err };
  } finally {
    spy.mockRestore();
  }
}

describe("genclass doctor reads a Content-Security-Policy as the browser does (src/doctor.mjs cspIn, cspGaps)", () => {
  it("a correct policy with quoted sources is read whole from every file form, and reported ok (finding 6)", async () => {
    const forms: Record<string, string> = {
      "index.html": `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${GOOD}"></head><body></body></html>`,
      "next.config.js": `module.exports = { async headers() { return [{ source: "/(.*)", headers: [{ key: "Content-Security-Policy", value: "${GOOD}" }] }]; } };\n`,
      "netlify.toml": `[[headers]]\n  for = "/*"\n  [headers.values]\n    Content-Security-Policy = "${GOOD}"\n`,
      "vercel.json": JSON.stringify({ headers: [{ source: "/(.*)", headers: [{ key: "Content-Security-Policy", value: GOOD }] }] }, null, 2),
      "public/_headers": `/*\n  Content-Security-Policy: ${GOOD}\n`,
    };
    for (const [file, text] of Object.entries(forms)) {
      const dir = appWith({ [file]: text });
      expect(cspIn(dir).map((x) => [x.file, x.policy])).toEqual([[file, GOOD]]);
      const rows = (await checks({ cwd: dir }, OFF)).filter((x: any) => x.id === "csp");
      expect(rows).toEqual([{ id: "csp", label: "Content policy", state: "ok", detail: `${file} allows what GenClass needs` }]);
    }
  });

  it("vercel.json is read, so a policy there that blocks GenClass is reported (finding 6, 8)", async () => {
    const dir = appWith({ "vercel.json": JSON.stringify({ headers: [{ source: "/(.*)", headers: [{ key: "Content-Security-Policy", value: "default-src 'self'; connect-src 'none'; script-src 'self' 'wasm-unsafe-eval'" }] }] }) });
    const csp = byId(await checks({ cwd: dir }, OFF)).csp;
    expect(csp).toMatchObject({ state: "bad" });
    expect(csp.detail).toContain("vercel.json: without connect-src https://genclass.dev");
    expect(csp.detail).toContain("connect-src https://cdn.jsdelivr.net");
  });

  it("JS policies built from templates, arrays joined, constants and calls after them; the Next.js nonce middleware", () => {
    const dir = appWith({
      "next.config.mjs": [
        "const ContentSecurityPolicy = [",
        `  "default-src 'self'",`,
        "  `connect-src 'self' https://genclass.dev https://cdn.jsdelivr.net`,",
        `  "script-src 'self' 'wasm-unsafe-eval'",`,
        '].join("; ");',
        'export default { async headers() { return [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: ContentSecurityPolicy.replace(/\\s{2,}/g, " ").trim() }] }]; } };',
      ].join("\n"),
      "src/middleware.ts": [
        "export function middleware(request) {",
        "  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')",
        "  const cspHeader = `",
        "    default-src 'self';",
        "    script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval';",
        "    connect-src 'self' https://genclass.dev https://cdn.jsdelivr.net;",
        "  `",
        "  const requestHeaders = new Headers(request.headers)",
        "  requestHeaders.set('Content-Security-Policy', cspHeader.replace(/\\s{2,}/g, ' ').trim())",
        "}",
      ].join("\n"),
    });
    const found = cspIn(dir);
    expect(found.map((x) => x.file)).toEqual(["next.config.mjs", "src/middleware.ts"]);
    expect(found[0]!.policy).toBe(GOOD);
    expect(found[1]!.policy).toContain("'strict-dynamic' 'wasm-unsafe-eval'");
    for (const { policy } of found) expect(cspGaps(policy, defaults)).toEqual([]);
  });

  it("a policy set only for other paths (/api/*) is left out, as are a report-only policy and one built at run time", () => {
    const dir = appWith({
      "public/_headers": `/api/*\n  Content-Security-Policy: default-src 'none'\n/*\n  Content-Security-Policy: ${GOOD}\n  Content-Security-Policy-Report-Only: default-src 'none'\n`,
      "vercel.json": JSON.stringify({ headers: [{ source: "/api/(.*)", headers: [{ key: "Content-Security-Policy", value: "default-src 'none'" }] }] }),
      "middleware.ts": "export function middleware(req) { res.headers.set('Content-Security-Policy', `${buildPolicy(req)}`); res.headers.set('Content-Security-Policy', policyFor(req)); }\n",
    });
    expect(cspIn(dir).map((x) => [x.file, x.policy])).toEqual([["public/_headers", GOOD]]);
    for (const r of ["/*", "/(.*)", "/:path*", "/((?!api|_next/static).*)", "**", "/", null]) expect(routeHasPages(r)).toBe(true);
    for (const r of ["/api/*", "/api/:path*", "/assets/(.*)", "**/*.@(js|css)", "/_next/static/:path*", "/*.png", "/(.*).(js|css)", "https://example.com/api/*"]) expect(routeHasPages(r)).toBe(false);
  });

  // a page route other than the home page: GenClass runs there too, so its policy is checked (fix2 doctor 0)
  it("a policy set for a section of the site (/app/*) is checked: in _headers, netlify.toml, vercel.json and next.config", async () => {
    for (const r of ["/app/*", "/app/:path*", "/dashboard/(.*)", "/docs", "/*.html", "/apiary/*"]) expect(routeHasPages(r)).toBe(true);
    const BLOCKS = "default-src 'self'; connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'";
    const forms: Record<string, string> = {
      "public/_headers": `/app/*\n  Content-Security-Policy: ${BLOCKS}\n`,
      "netlify.toml": `[[headers]]\n  for = "/app/*"\n  [headers.values]\n    Content-Security-Policy = "${BLOCKS}"\n`,
      "vercel.json": JSON.stringify({ headers: [{ source: "/app/(.*)", headers: [{ key: "Content-Security-Policy", value: BLOCKS }] }] }),
      "next.config.js": `module.exports = { async headers() { return [{ source: "/app/:path*", headers: [{ key: "Content-Security-Policy", value: "${BLOCKS}" }] }]; } };\n`,
    };
    for (const [file, text] of Object.entries(forms)) {
      const dir = appWith({ [file]: text });
      expect(cspIn(dir).map((x) => x.file)).toEqual([file]);
      const csp = byId(await checks({ cwd: dir }, OFF)).csp;
      expect(csp).toMatchObject({ state: "bad" });
      expect(csp.detail).toContain(`${file}: without connect-src https://genclass.dev`);
      expect(csp.detail).toContain("connect-src https://cdn.jsdelivr.net");
    }
  });

  // Cloudflare Pages' and Netlify's parsers trim each line, and Cloudflare's path may be an absolute URL (fix2 doctor 1)
  it("_headers as the hosts read it: header lines without indentation, and a path line that is an absolute URL", async () => {
    const BLOCKS = "default-src https://x.example; connect-src https://x.example; script-src 'self' 'wasm-unsafe-eval'";
    for (const text of [`/*\nContent-Security-Policy: ${BLOCKS}\n`, `https://example.com/*\n  Content-Security-Policy: ${BLOCKS}\n`, `https://:project.pages.dev/*\nContent-Security-Policy: ${BLOCKS}\n`]) {
      const dir = appWith({ "public/_headers": text });
      expect(cspIn(dir).map((x) => [x.file, x.policy])).toEqual([["public/_headers", BLOCKS]]);
      expect(byId(await checks({ cwd: dir }, OFF)).csp).toMatchObject({ state: "bad", fix: "add connect-src https://genclass.dev, connect-src https://cdn.jsdelivr.net to the policy in public/_headers" });
    }
    expect(routeHasPages("https://example.com/*")).toBe(true);
    expect(routeHasPages("https://example.com")).toBe(true);
    // a header before any path line is not applied by either host, and an API path's stays left out
    const dir = appWith({ "public/_headers": `Content-Security-Policy: default-src 'none'\nhttps://example.com/api/*\nContent-Security-Policy: default-src 'none'\n/*\nContent-Security-Policy: ${GOOD}\n` });
    expect(cspIn(dir).map((x) => x.policy)).toEqual([GOOD]);
  });

  // the route is the `source` of the entry the header is in, written before or after its headers (fix2 doctor 2)
  it("a next.config header's route is its own entry's source, not the last source written before it (redirects first)", () => {
    const dir = appWith({
      "next.config.js": [
        "const strip = (s) => s.replace(/[{}]/g, \"\").replace(/\\{/g, `{`);",
        "module.exports = {",
        "  async redirects() {",
        '    return [{ source: "/old", destination: "/new", permanent: true }];',
        "  },",
        "  async headers() {",
        "    return [",
        `      { headers: [{ key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: "default-src 'self'; connect-src 'none'" }], source: "/(.*)" },`,
        `      { headers: [{ key: "Content-Security-Policy", value: "default-src 'none'" }], "source": "/api/(.*)" },`,
        "    ];",
        "  },",
        "};",
      ].join("\n"),
    });
    expect(cspIn(dir).map((x) => [x.route, x.policy])).toEqual([["/(.*)", "default-src 'self'; connect-src 'none'"]]);
    // a list kept in a constant, used by an entry further down: for every page it is used on, so it is checked
    const kept = appWith({
      "next.config.mjs": `const securityHeaders = [{ key: "Content-Security-Policy", value: "default-src 'self'" }];\nexport default { async redirects() { return [{ source: "/api/old", destination: "/api/new", permanent: false }]; }, async headers() { return [{ source: "/(.*)", headers: securityHeaders }]; } };\n`,
    });
    expect(cspIn(kept).map((x) => [x.route, x.policy])).toEqual([[null, "default-src 'self'"]]);
  });

  // the onnxruntime-web the runtime asks jsDelivr for is the version it pins, not an older one (fix2 doctor 3)
  it("a jsDelivr source limited to the model's and onnxruntime-web's folders lets the model load, for the version the runtime pins", async () => {
    const pin = JSON.parse(readFileSync(new URL("../../runtime/package.json", import.meta.url), "utf8")).dependencies["onnxruntime-web"];
    const modelBase = /DEFAULT_MODEL_BASE_URL = "([^"]+)"/.exec(readFileSync(new URL("../../runtime/src/model/host.ts", import.meta.url), "utf8"))![1];
    const policy = (ort: string) => `default-src 'self'; connect-src 'self' https://genclass.dev ${modelBase} https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort}/; script-src 'self' 'wasm-unsafe-eval'`;
    expect(cspGaps(policy(pin), defaults)).toEqual([]);
    expect(cspGaps(policy("1.22.0"), defaults).map((g) => g.need)).toEqual(["connect-src https://cdn.jsdelivr.net"]);
    // the WebGPU build's wasm is needed as well as the WASM build's
    const one = `default-src 'self'; connect-src 'self' https://genclass.dev ${modelBase} https://cdn.jsdelivr.net/npm/onnxruntime-web@${pin}/dist/ort-wasm-simd-threaded.wasm; script-src 'self' 'wasm-unsafe-eval'`;
    expect(cspGaps(one, defaults).map((g) => g.need)).toEqual(["connect-src https://cdn.jsdelivr.net"]);
    // an app whose installed runtime pins another version: that is the one its pages load
    const older = appWith({ "node_modules/@genclass/runtime/package.json": JSON.stringify({ name: "@genclass/runtime", version: "0.3.0-beta.6", dependencies: { "onnxruntime-web": "1.29.0" } }), "public/_headers": `/*\n  Content-Security-Policy: ${policy("1.29.0")}\n` });
    expect(byId(await checks({ cwd: older }, OFF)).csp).toMatchObject({ state: "ok" });
    expect(cspGaps(policy("1.29.0"), defaults, { ort: "1.29.0" })).toEqual([]);
  });

  it("scheme sources (https:), hosts without a scheme, wildcards, paths, keyword case and the first of a repeated directive (finding 8)", () => {
    const tail = "; script-src 'self' 'wasm-unsafe-eval'";
    expect(cspGaps(`default-src 'self'; connect-src 'self' https:${tail}`, defaults)).toEqual([]);
    expect(cspGaps(`default-src 'self'; connect-src 'self' http:${tail}`, defaults)).toEqual([]);
    expect(cspGaps(`default-src 'self'; connect-src genclass.dev cdn.jsdelivr.net${tail}`, defaults)).toEqual([]);
    expect(cspGaps(`default-src 'self'; connect-src https://genclass.dev/api/ https://cdn.jsdelivr.net/npm/${tail}`, defaults)).toEqual([]);
    expect(cspGaps(`default-src *${tail}`, defaults)).toEqual([]);
    expect(cspGaps("DEFAULT-SRC 'SELF'; CONNECT-SRC https://genclass.dev https://cdn.jsdelivr.net; SCRIPT-SRC 'SELF' 'WASM-UNSAFE-EVAL'", defaults)).toEqual([]);
    // what really blocks: a subdomain wildcard is not the domain itself, a path that is not GenClass's, 'none'
    expect(cspGaps(`default-src 'self'; connect-src https://*.genclass.dev https://*.jsdelivr.net${tail}`, defaults).map((g) => g.need)).toEqual(["connect-src https://genclass.dev"]);
    expect(cspGaps(`default-src 'self'; connect-src https://genclass.dev/other https://cdn.jsdelivr.net${tail}`, defaults).map((g) => g.need)).toEqual(["connect-src https://genclass.dev"]);
    expect(cspGaps(`default-src 'self'; connect-src 'none'; connect-src *${tail}`, defaults).map((g) => g.need)).toEqual(["connect-src https://genclass.dev", "connect-src https://cdn.jsdelivr.net"]);
    expect(sourceAllows(["https://genclass.dev:443"], "https://genclass.dev/api/v1/events")).toBe(true);
    expect(sourceAllows(["https://genclass.dev:8443"], "https://genclass.dev/api/v1/events")).toBe(false);
    expect(sourceAllows(["*"], "blob:https://site.invalid/0")).toBe(false);
    expect(sourceAllows(["blob:"], "blob:https://site.invalid/0")).toBe(true);
    expect(sourceAllows(null, "https://genclass.dev/")).toBe(true);
  });

  it("several policies (a header's comma-separated list, two meta tags): each is enforced, so each one's gaps count", async () => {
    expect(cspGaps(`default-src *; script-src * 'wasm-unsafe-eval', connect-src 'self'`, defaults).map((g) => g.need)).toEqual(["connect-src https://genclass.dev", "connect-src https://cdn.jsdelivr.net"]);
    const dir = appWith({ "index.html": `<meta http-equiv="Content-Security-Policy" content="${GOOD}">\n<meta content="script-src 'self'" http-equiv="content-security-policy">` });
    const csp = byId(await checks({ cwd: dir }, OFF)).csp;
    expect(csp).toMatchObject({ state: "bad", fix: "add script-src 'wasm-unsafe-eval' to the policy in index.html" });
  });

  it("the model's worker: worker-src, else child-src, script-src, default-src; blob: for the script tag, which needs script-src too (finding 43)", () => {
    const base = "default-src 'self'; connect-src 'self' https://genclass.dev https://cdn.jsdelivr.net";
    expect(cspGaps(`${base}; script-src 'self' 'wasm-unsafe-eval'; worker-src 'none'`, defaults).map((g) => g.need)).toEqual(["worker-src 'self'"]);
    expect(cspGaps(`${base}; script-src 'self' 'wasm-unsafe-eval'; child-src 'none'`, defaults).map((g) => g.need)).toEqual(["worker-src 'self'"]);
    expect(cspGaps(`${base}; script-src 'self' 'wasm-unsafe-eval'; child-src 'none'; worker-src 'self'`, defaults)).toEqual([]);
    expect(cspGaps(`${base}; script-src 'wasm-unsafe-eval' 'nonce-abc' 'strict-dynamic'`, defaults)).toEqual([]);
    // the script tag: its worker starts from a blob: URL
    const tagPolicy = `${base}; script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'`;
    const gaps = cspGaps(tagPolicy, defaults, { script: TAG });
    expect(gaps.map((g) => g.need)).toEqual(["worker-src blob:"]);
    expect(gaps[0]!.why).toContain("the model runs on the main thread");
    expect(cspGaps(`${tagPolicy}; worker-src 'self' blob:`, defaults, { script: TAG })).toEqual([]);
    expect(cspGaps(`${base}; script-src 'self' 'wasm-unsafe-eval' blob:`, defaults, { script: TAG }).map((g) => g.need)).toEqual(["script-src https://cdn.jsdelivr.net"]);
    expect(cspGaps("default-src 'self'; worker-src 'none'", readSetupText("telemetry: false, model: false"))).toEqual([]);
  });

  it("the self-hosting route is the whole command: fetch-model with the folder the framework serves, then init --model-url (finding 79)", () => {
    const why = cspGaps(`default-src 'self'; connect-src 'self' https://genclass.dev; script-src 'self' 'wasm-unsafe-eval'`, defaults)[0]!.why;
    expect(why).toContain(`${RT} fetch-model public/genclass-model, then ${RT} init --model-url /genclass-model/`);
    const svelte = cspGaps("connect-src 'self'", readSetupText("telemetry: false"), { publicDir: publicDirOf({ framework: "sveltekit", dir: tempDir() }) })[0]!.why;
    expect(svelte).toContain(`${RT} fetch-model static/genclass-model, then`);
  });
});

describe("genclass doctor finds the project the way its tools do (src/doctor.mjs checks)", () => {
  it("a workspaces monorepo: the runtime hoisted to the root and the MCP configuration at the repository's root (findings 10, 24, 29)", async () => {
    const root = tempDir();
    write(root, { "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), ...RUNTIME, ".mcp.json": MCP("0.1.0") });
    const web = join(root, "apps", "web");
    mkdirSync(web, { recursive: true });
    viteApp(web);
    write(web, { "src/main.jsx": INIT_ENTRY, "src/genclass.config.ts": CONFIG('token: "gc_AbCdEfGhIjKlMnOpQrStUv"'), "vite.config.js": "export default {};" });
    const deps = { ...OFF, runGit: (args: string[]) => (args.includes("--show-toplevel") ? root : null) };
    const by = byId(await checks({ cwd: web }, deps));
    expect(by.runtime).toMatchObject({ state: "ok", detail: "@genclass/runtime 0.3.0-beta.6, observe mode" });
    expect(by.mcp).toMatchObject({ state: "warn" });
    expect(by.mcp.detail).toBe(`${join("..", "..", ".mcp.json")} pins @genclass/mcp 0.1.0; this command installs ${BUILD.mcpVersion}`);
    // --fix updates the root's file, where the agent reads it
    await both(async () => doctor({ cwd: web, fix: true, yes: true }, deps));
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toContain(`@genclass/mcp@${BUILD.mcpVersion}`);
    expect(existsSync(join(web, ".mcp.json"))).toBe(false);
    expect(byId(await checks({ cwd: web }, deps)).mcp).toMatchObject({ state: "ok", detail: `${join("..", "..", ".mcp.json")} (@genclass/mcp ${BUILD.mcpVersion})` });
  });

  it("the agent configurations status reads: Codex's config.toml (pinned, and its pin updated) and a global genclass-mcp (finding 29)", async () => {
    const codex = appWith({ ".codex/config.toml": '[mcp_servers.genclass]\ncommand = "npx"\nargs = ["-y", "@genclass/mcp@0.1.0"]\n' });
    const by = byId(await checks({ cwd: codex }, OFF));
    expect(by.mcp).toMatchObject({ state: "warn", fix: "npx genclass doctor --fix" });
    expect(by.mcp.detail).toContain(".codex/config.toml pins @genclass/mcp 0.1.0");
    expect(by.skill).toMatchObject({ state: "warn" });
    const global = appWith({ ".cursor/mcp.json": JSON.stringify({ mcpServers: { genclass: { command: "genclass-mcp" } } }) });
    expect(byId(await checks({ cwd: global }, OFF)).mcp).toMatchObject({ state: "ok", detail: ".cursor/mcp.json (unpinned)" });
  });

  it("a plain HTML site with GenClass's script tag: the tag's version, no npm install, and no agent link to add (finding 23)", async () => {
    const dir = tempDir();
    write(dir, {
      "index.html": `<!doctype html>\n<html>\n<head>\n  <script src="${TAG}" defer></script> <!-- genclass:init -->\n  <title>Shop</title>\n</head>\n<body></body>\n</html>\n`,
      ".mcp.json": MCP(),
      ".claude/skills/genclass/SKILL.md": skillText(),
    });
    const by = byId(await checks({ cwd: dir }, OFF));
    expect(by.runtime).toMatchObject({ state: "ok", detail: "script tag, @genclass/runtime 0.3.0-beta.6 in index.html, observe mode" });
    expect(by.link).toMatchObject({ state: "info" });
    expect(by.link.fix).toBeUndefined();
    let code = -1;
    await both(async () => (code = await doctor({ cwd: dir }, OFF)));
    expect(code).toBe(0);
    // an older tag than npm's newest: what to change, not `npm install`
    const tags = tagsFetch({ latest: BUILD.version }, { beta: "0.3.0-beta.9", latest: "0.2.0" });
    const older = byId(await checks({ cwd: dir }, { ...OFF, offline: false, fetchFn: tags })).runtime;
    expect(older).toMatchObject({ state: "warn", fix: "put 0.3.0-beta.9 in the script tag's src in index.html, and update its integrity attribute (or take it out)" });
    // its policy: the tag needs script-src, its worker blob:
    write(dir, { "public/_headers": `/*\n  Content-Security-Policy: default-src 'self'; connect-src 'self' https://genclass.dev https://cdn.jsdelivr.net; script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'\n` });
    const csp = byId(await checks({ cwd: dir }, OFF)).csp;
    expect(csp).toMatchObject({ state: "bad", fix: "add worker-src blob: to the policy in public/_headers" });
  });

  it("signed out: the account row and the fixes say what needs Pro and name the free commands (finding 72)", async () => {
    const dir = tempDir();
    viteApp(dir);
    const by = byId(await checks({ cwd: dir }, OFF));
    expect(by.account).toMatchObject({ state: "info", fix: "npx genclass login" });
    expect(by.account.detail).toBe("no: the runtime and the MCP server work without an account; npx genclass setup needs a sign-in and Pro");
    expect(by.runtime.fix).toBe(`npx genclass setup (with Pro), or without an account: ${RT} init`);
    expect(by.mcp.fix).toBe(`npx genclass setup (the Coding agent step, with Pro), or without an account: npx -y @genclass/mcp@${BUILD.mcpVersion} init`);
  });
});

describe("genclass doctor: the skill, compared without its marker (src/doctor.mjs)", () => {
  const MCP_MARK = (v: string) => skillText().replace("written by `npx genclass`", `written by \`npx -y @genclass/mcp@${v} init\``);
  const stale = (t: string) => t.replace(/\n## /, "\nAn older line.\n\n## ");
  const skillRow = async (text: string, extra: Record<string, string> = {}) => {
    const dir = appWith({ ".mcp.json": MCP(), ".claude/skills/genclass/SKILL.md": text, ...extra });
    return { dir, row: byId(await checks({ cwd: dir }, OFF)).skill };
  };

  it("the skill `npx @genclass/mcp init` wrote, the same text under its own marker, is current (finding 40)", async () => {
    expect(MCP_MARK(BUILD.mcpVersion)).not.toBe(skillText());
    expect((await skillRow(MCP_MARK(BUILD.mcpVersion))).row).toMatchObject({ state: "ok", detail: ".claude/skills/genclass/SKILL.md" });
  });

  it("a skill from a newer @genclass/mcp, by its marker or the project's pin, is never replaced by this older copy (finding 40)", async () => {
    const newer = await skillRow(stale(MCP_MARK("9.9.9")));
    expect(newer.row).toMatchObject({ state: "ok" });
    expect(newer.row.apply).toBeUndefined();
    const pinned = await skillRow(stale(skillText()), { ".mcp.json": MCP("9.9.9") });
    expect(pinned.row).toMatchObject({ state: "info", fix: "npx -y @genclass/mcp@9.9.9 init (writes that version's skill)" });
    expect(pinned.row.apply).toBeUndefined();
  });

  it("an older skill with the marker is replaced, one without it is left alone", async () => {
    const old = await skillRow(stale(MCP_MARK("0.1.0")));
    expect(old.row).toMatchObject({ state: "warn", detail: ".claude/skills/genclass/SKILL.md is from another version (@genclass/mcp 0.1.0)" });
    await both(async () => doctor({ cwd: old.dir, fix: true, yes: true }, OFF));
    expect(readFileSync(join(old.dir, ".claude/skills/genclass/SKILL.md"), "utf8")).toBe(skillText());
    const yours = await skillRow(stale(skillText()).replace(/<!-- genclass:init[^\n]*-->\n/, ""));
    expect(yours.row).toMatchObject({ state: "ok" });
    expect(yours.row.detail).toContain("yours");
  });

  it("a Windows checkout's CRLF skill is current, and a stale one is rewritten with CRLF (finding 48)", async () => {
    const crlf = (t: string) => t.replace(/\n/g, "\r\n");
    expect((await skillRow(crlf(skillText()))).row).toMatchObject({ state: "ok" });
    const old = await skillRow(crlf(stale(skillText())));
    expect(old.row).toMatchObject({ state: "warn" });
    await both(async () => doctor({ cwd: old.dir, fix: true, yes: true }, OFF));
    expect(readFileSync(join(old.dir, ".claude/skills/genclass/SKILL.md"), "utf8")).toBe(crlf(skillText()));
  });
});

describe("genclass doctor --fix shows each change, and --json stays JSON (src/doctor.mjs doctor)", () => {
  it("--fix --yes prints each change itself (the diff, a new skill by name and size) before it writes (finding 46)", async () => {
    const dir = appWith({ ".mcp.json": MCP("0.1.0") });
    const { out } = await both(async () => doctor({ cwd: dir, fix: true, yes: true }, OFF));
    const said = plain(out);
    const diff = said.indexOf("+ if (import.meta.env.DEV) connectAgent(GenClass.init());");
    expect(diff).toBeGreaterThan(-1);
    expect(said).toMatch(/\.mcp\.json \(modify\)\n[^]*-\s+"@genclass\/mcp@0\.1\.0"\n\s+\+\s+"@genclass\/mcp@\d/);
    expect(said).toMatch(/\.claude\/skills\/genclass\/SKILL\.md \(new file\)\n\s+\d+ lines: the procedure your coding agent follows/);
    expect(diff).toBeLessThan(said.indexOf("Wrote"));
  });

  it("--json --fix prints one JSON object on stdout, the report on stderr; it writes with --yes only and never asks (finding 47)", async () => {
    const dir = appWith({ ".mcp.json": MCP("0.1.0") });
    const before = readFileSync(join(dir, "src/main.jsx"), "utf8");
    const dry = await both(async () => expect(await doctor({ cwd: dir, fix: true, json: true }, OFF)).toBe(1));
    const j0 = JSON.parse(dry.out);
    expect(j0.fixed).toEqual([]);
    expect(j0.skipped).toHaveLength(3);
    expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toBe(before);
    expect(plain(dry.err)).toContain("Nothing was written");
    let code = -1;
    const run = await both(async () => (code = await doctor({ cwd: dir, fix: true, yes: true, json: true }, OFF)));
    const j = JSON.parse(run.out);
    expect(j.fixed).toEqual([`.mcp.json: @genclass/mcp 0.1.0 to ${BUILD.mcpVersion}`, ".claude/skills/genclass/SKILL.md: the skill", "src/genclass.agent.js: the coding-agent link, development builds only; src/main.jsx: the line that imports src/genclass.agent.js, right after GenClass's import"]);
    expect(j.failed).toEqual([]);
    expect(j.ok).toBe(code === 0);
    expect(j.checks.find((x: any) => x.id === "mcp")).toMatchObject({ state: "warn", fixable: true });
    expect(plain(run.err)).toContain("Wrote .mcp.json");
    expect(readFileSync(join(dir, "src/genclass.agent.js"), "utf8")).toContain("connectAgent(GenClass.init())");
    expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toContain('import "./genclass.agent.js"; // genclass:init');
  });

  it("after linking the dev page, the agent is asked about the page only when its configuration names GenClass's server (finding 76)", async () => {
    const none = appWith();
    const said = plain((await both(async () => doctor({ cwd: none, fix: true, yes: true }, OFF))).out).replace(/\s+/g, " ");
    expect(said).toContain("Wrote src/genclass.agent.js: the coding-agent link");
    expect(said).not.toContain("genclass_status lists the page");
    expect(said).toContain(`Your coding agent has no GenClass tools in this project yet: npx -y @genclass/mcp@${BUILD.mcpVersion} init adds GenClass's server`);
    const configured = appWith({ ".mcp.json": MCP() });
    expect(plain((await both(async () => doctor({ cwd: configured, fix: true, yes: true }, OFF))).out).replace(/\s+/g, " ")).toContain("genclass_status lists the page");
  });
});

describe("genclass doctor and the update notice: versions against the line this build is on", () => {
  it("newestFor: the newer of latest and the build's own prerelease line; a release is never sent to a prerelease", () => {
    expect(newestFor("0.4.0-alpha.0", { latest: "0.3.9", alpha: "0.4.0-alpha.1" })).toEqual({ version: "0.4.0-alpha.1", tag: "alpha" });
    expect(newestFor("0.4.0-alpha.0", { latest: "0.4.0", alpha: "0.4.0-alpha.1" })).toEqual({ version: "0.4.0", tag: "latest" });
    expect(newestFor("0.3.8", { latest: "0.3.9", alpha: "0.4.0-alpha.1" })).toEqual({ version: "0.3.9", tag: "latest" });
    expect(newestFor("0.3.0-beta.6", { latest: "0.2.9", beta: "0.3.0-beta.9", alpha: "0.4.0-alpha.1" })).toEqual({ version: "0.3.0-beta.9", tag: "beta" });
    expect(newestFor("0.4.0-alpha.0", null)).toEqual({ version: null, tag: "latest" });
  });

  it.runIf(!!channel(BUILD.version))("doctor tells an outdated prerelease about its line's newer release, with that tag (finding 93)", async () => {
    const ch = channel(BUILD.version)!;
    const next = BUILD.version.replace(/(\d+)$/, (n) => String(Number(n) + 1));
    const dir = appWith();
    const outdated = byId(await checks({ cwd: dir }, { ...OFF, offline: false, fetchFn: tagsFetch({ latest: "0.3.9", [ch]: next }) })).cli;
    expect(outdated).toEqual({ id: "cli", label: "This command", state: "warn", detail: `${BUILD.version}; ${next} is out`, fix: `npm install -g genclass@${ch}` });
    const current = byId(await checks({ cwd: dir }, { ...OFF, offline: false, fetchFn: tagsFetch({ latest: "0.3.9", [ch]: BUILD.version }) })).cli;
    expect(current).toMatchObject({ state: "ok", detail: `${BUILD.version} (the newest)` });
  });

  it("the update notice reads the remembered dist-tag of the current line, and remembers every tag (finding 93)", async () => {
    const { refreshLatest, updateLine } = await import("../src/update.mjs");
    const prefs = { latestGenclass: "0.3.9", genclassTags: { alpha: "0.4.0-alpha.1" } };
    expect(updateLine("0.4.0-alpha.0", prefs)?.text).toBe("genclass 0.4.0-alpha.1 is out (this is 0.4.0-alpha.0): npm install -g genclass@alpha");
    expect(updateLine("0.4.0-alpha.1", prefs)).toBeNull();
    expect(updateLine("0.3.8", prefs)?.text).toBe("genclass 0.3.9 is out (this is 0.3.8): npm install -g genclass@latest");
    const fetchFn = (async () => new Response(JSON.stringify({ latest: "0.3.9", alpha: "0.4.0-alpha.2", beta: "0.3.0-beta.1", bad: "x" }), { status: 200 })) as unknown as typeof fetch;
    await refreshLatest(1_000_000_000_000, fetchFn, {});
    const { readPrefs } = await import("../src/name.mjs");
    expect(readPrefs()).toMatchObject({ latestGenclass: "0.3.9", genclassTags: { alpha: "0.4.0-alpha.2", beta: "0.3.0-beta.1" }, latestCheckedAt: 1_000_000_000_000 });
    expect(readPrefs().genclassTags.bad).toBeUndefined();
    expect(updateLine("0.4.0-alpha.0")?.text).toContain("npm install -g genclass@alpha");
  });
});

describe("genclass doctor: the genclass a shell runs, not npx's own copy (src/doctor.mjs userPath)", () => {
  it("userPath drops npx's folders and node_modules/.bin", () => {
    expect(userPath({ PATH: "/u/.npm/_npx/abc/node_modules/.bin:/usr/local/bin:/app/node_modules/.bin:/usr/bin" }, "darwin")).toEqual({ key: "PATH", value: "/usr/local/bin:/usr/bin" });
    expect(userPath({ Path: "C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\.bin;C:\\Users\\u\\AppData\\Roaming\\npm" }, "win32")).toEqual({ key: "Path", value: "C:\\Users\\u\\AppData\\Roaming\\npm" });
  });

  it.skipIf(process.platform === "win32")("under npx, the PATH check runs the installed genclass, not npx's copy (finding 49)", async () => {
    const tmp = tempDir();
    const npxBin = join(tmp, ".npm", "_npx", "abc", "node_modules", ".bin");
    const userBin = join(tmp, "bin");
    for (const [d, v] of [[npxBin, BUILD.version], [userBin, "0.3.1"]] as const) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "genclass"), `#!/bin/sh\necho "genclass ${v}"\n`);
      chmodSync(join(d, "genclass"), 0o755);
    }
    const saved = process.env.PATH;
    process.env.PATH = [npxBin, userBin, saved].join(":");
    try {
      const by = byId(await checks({ cwd: appWith() }, { ...OFF, pathVersion: undefined }));
      expect(by["cli-path"]).toMatchObject({ detail: `typing genclass runs 0.3.1, not ${BUILD.version}` });
    } finally {
      process.env.PATH = saved;
    }
  });
});
