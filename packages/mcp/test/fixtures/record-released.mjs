// Records what a released @genclass/mcp answers when two apps run on this machine, into
// test/fixtures/released-mcp.json, which the manifests test reads to check the skill's advice for a release without
// explore `wait` or `origin` (finding 45): 0.2.2, the release a project set up before those still pins. It runs the
// release's own Store, API and callTool from its git tag, bundled with esbuild into a temporary folder: no network, no
// server, no install. A version bump needs no new recording: the test checks the fallbacks against what the recorded
// release lacks, so the recording stays on 0.2.2. To record it again:
//   node packages/mcp/test/fixtures/record-released.mjs mcp-v0.2.2
// `--src <dir>` records the sources in that folder instead of a tag (the manifests test records this package's own),
// and `--out <file>` writes there instead of the fixture. The explore `wait` call is made only on a release whose
// explore lacks it, to record that it is refused: on one that has it the call blocks until its timeout, and with the
// fixed clock here never would. Each call has CALL_MS to answer, or the recording stops with the call named.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CALL_MS = 10_000;
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  argv.splice(i, 2);
  return v;
};
const srcDir = flag("--src");
const outFile = flag("--out");
const tag = argv[0] ?? "mcp-v0.2.2";
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const dir = mkdtempSync(join(tmpdir(), "gc-released-"));
let code = 0;
try {
  let src;
  if (srcDir) src = resolve(srcDir);
  else {
    execFileSync("sh", ["-c", `git -C "${repo}" archive "${tag}" packages/mcp/src | tar -x -C "${dir}"`]);
    src = join(dir, "packages", "mcp", "src");
  }
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, `export { Store } from "${src}/store.ts";\nexport { makeApi } from "${src}/api.ts";\nexport { callTool, TOOLS } from "${src}/tools.ts";\nexport { VERSION } from "${src}/http.ts";\n`);
  const out = join(dir, "released.mjs");
  // esbuild comes with tsup
  const { build } = await import("esbuild");
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
  const { Store, makeApi, callTool, TOOLS, VERSION } = await import(pathToFileURL(out).href);
  const explore = TOOLS.find((t) => t.name === "genclass_explore").inputSchema.properties.action.enum;

  const now = 1_000_000;
  const store = new Store({ now: () => now });
  const api = makeApi(store, { url: "http://127.0.0.1:47357", port: 47357 });
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
    // a call that does not answer in time ends the recording (a ref'd timer, so node waits for it rather than exiting
    // with an unsettled top-level await); the signal ends a release's own wait loop
    const ctl = new AbortController();
    let timer;
    const late = new Promise((_, no) => {
      timer = setTimeout(() => {
        ctl.abort();
        no(new Error(`${tool} ${JSON.stringify(args)} did not answer in ${CALL_MS / 1000} s: nothing recorded`));
      }, CALL_MS);
    });
    const ctx = { api: async (m, p) => api(m, p), now: () => now, cwd: dir, env: {}, signal: ctl.signal };
    let r;
    try {
      r = await Promise.race([callTool(tool, args, ctx), late]);
    } catch (e) {
      if (ctl.signal.aborted) throw e;
      r = { text: String(e?.message ?? e), isError: true };
    } finally {
      clearTimeout(timer);
    }
    calls.push({ tool, args, isError: !!r.isError, text: r.text });
  };
  await call("genclass_status", {});
  await call("genclass_status", { origin: "5173" });
  await call("genclass_findings", {});
  await call("genclass_findings", { origin: "5173" });
  for (const id of ["f1", "f2"]) await call("genclass_explain", { id });
  await call("genclass_explore", { action: "start", runs: 1 });
  if (!explore.includes("wait")) await call("genclass_explore", { action: "wait" });
  const args = Object.fromEntries(TOOLS.map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {})]));
  const from = srcDir ? "the sources in --src" : tag;
  const fixture = { release: VERSION, tag: srcDir ? null : tag, recorded: `by test/fixtures/record-released.mjs from ${from}: two apps (${APPS.join(", ")}) with one page load on "/" each and one stale-write finding each`, apps: APPS, arguments: args, exploreActions: explore, calls };
  const file = outFile ? resolve(outFile) : join(here, "released-mcp.json");
  writeFileSync(file, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`recorded ${calls.length} calls of ${VERSION} into ${outFile ? file : "test/fixtures/released-mcp.json"}`);
} catch (e) {
  console.error(`record-released: ${e?.message ?? e}`);
  code = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
// the release's own timers (a poll it left behind) must not keep the recording open
process.exit(code);
