// Records what the released @genclass/mcp (the one the CLI pins beside the skill) answers when two apps run on this
// machine, into test/fixtures/released-mcp.json, which the manifests test reads to check the skill's advice for that
// release (finding 45). It runs the release's own Store, API and callTool from its git tag, bundled with esbuild into
// a temporary folder: no network, no server, no install. Run it again when the pin moves:
//   node packages/mcp/test/fixtures/record-released.mjs mcp-v0.2.2
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tag = process.argv[2] ?? "mcp-v0.2.2";
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const dir = mkdtempSync(join(tmpdir(), "gc-released-"));
try {
  execFileSync("sh", ["-c", `git -C "${repo}" archive "${tag}" packages/mcp/src | tar -x -C "${dir}"`]);
  const src = join(dir, "packages", "mcp", "src");
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, `export { Store } from "${src}/store.ts";\nexport { makeApi } from "${src}/api.ts";\nexport { callTool, TOOLS } from "${src}/tools.ts";\nexport { VERSION } from "${src}/http.ts";\n`);
  const out = join(dir, "released.mjs");
  execFileSync(join(repo, "node_modules", ".bin", "esbuild"), [entry, "--bundle", "--platform=node", "--format=esm", `--outfile=${out}`, "--log-level=error"]);
  const { Store, makeApi, callTool, TOOLS, VERSION } = await import(pathToFileURL(out).href);

  const now = 1_000_000;
  const store = new Store({ now: () => now });
  const api = makeApi(store, { url: "http://127.0.0.1:47357", port: 47357 });
  const ctx = { api: async (m, p) => api(m, p), now: () => now, cwd: dir, env: {} };
  const APPS = ["http://localhost:5173", "http://localhost:3000"];
  // one page load on "/" per app, each with a response that overwrote newer data: a stale-write finding per app (on
  // another field in each, so the release keeps them apart; the same route and cause in both would be one finding)
  for (const [n, origin] of APPS.entries()) {
    const field = ["search.results", "cart.items"][n];
    const h = store.hello({ schema: "genclass-agent/1", page: { url: `${origin}/`, route: "/", title: "App" }, runtime: { mode: "observe", model: "ready" } }, origin);
    store.events(
      {
        run: h.run,
        token: h.token,
        events: [
          { t: "steps", steps: [{ k: "act", i: 0, t: 0, kind: "type", target: 'searchbox "Search"', value: "react" }, { k: "send", t: 10, key: "GET /api/search#1", act: 0 }, { k: "send", t: 30, key: "GET /api/search#2", act: 0 }], order: ["GET /api/search#2", "GET /api/search#1"] },
          { t: "witness", witness: { kind: "overwrote-newer", t: 900, subject: field, by: "GET /api/search#1", over: "GET /api/search#2", overKind: "request", gapMs: 20 } },
        ],
      },
      origin,
    );
  }
  const calls = [];
  const call = async (tool, args) => {
    let r;
    try {
      r = await callTool(tool, args, ctx);
    } catch (e) {
      r = { text: String(e?.message ?? e), isError: true };
    }
    calls.push({ tool, args, isError: !!r.isError, text: r.text });
  };
  await call("genclass_status", {});
  await call("genclass_status", { origin: "5173" });
  await call("genclass_findings", {});
  await call("genclass_findings", { origin: "5173" });
  for (const id of ["f1", "f2"]) await call("genclass_explain", { id });
  await call("genclass_explore", { action: "start", runs: 1 });
  await call("genclass_explore", { action: "wait" });
  const args = Object.fromEntries(TOOLS.map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {})]));
  const explore = TOOLS.find((t) => t.name === "genclass_explore").inputSchema.properties.action.enum;
  const fixture = { release: VERSION, tag, recorded: `by test/fixtures/record-released.mjs from ${tag}: two apps (${APPS.join(", ")}) with one page load on "/" each and one stale-write finding each`, apps: APPS, arguments: args, exploreActions: explore, calls };
  writeFileSync(join(here, "released-mcp.json"), JSON.stringify(fixture, null, 1) + "\n");
  console.log(`recorded ${calls.length} calls of ${VERSION} into test/fixtures/released-mcp.json`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
