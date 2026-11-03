// The plugin in the real OpenCode binaries: `node packages/opencode-plugin/test/smoke/run.mjs` after
// `npm run build -w opencode-genclass`. Installs opencode-ai@1.19.5 (OpenCode 1.x) and @opencode/cli@2.2.5 (2.x) into
// a temporary directory from npm (or uses OPENCODE_V1 / OPENCODE_V2, paths to the `opencode` binaries), and in
// throwaway projects with their own HOME and XDG directories (nothing of the user's configuration is read or written):
//
//   1. control: no plugin, `opencode mcp list` lists no genclass server (both lines);
//   2. the plugin from this checkout (an absolute path in `plugin` / `plugins`): genclass is listed and connected
//      (OpenCode starts the real @genclass/mcp from npm with npx);
//   3. a project that configures its own `genclass` server: that one is used (it exits at once, so it is listed as
//      failed), not the plugin's;
//   4. OpenCode 1.x end to end: a local OpenAI-compatible stub stands in for the model and a stub GenClass bridge
//      answers `digest`; `opencode run` sends the user's message with the findings digest appended as a text part,
//      the `intervention` finding filtered out, and the cursor file advances.
//
// Needs network access to npm (the binaries, @genclass/mcp, and OpenCode 1.x's provider package for the stub model). Prints one line per check and exits 1 on a failure.
// OpenCode 2.x starts plugins after its background service boots, so its checks poll `mcp list` for up to 60 s.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = resolve(fileURLToPath(new URL("../..", import.meta.url)));
if (!existsSync(join(PLUGIN, "dist", "index.js"))) {
  console.error("build the plugin first: npm run build -w opencode-genclass");
  process.exit(2);
}
const MCP = JSON.parse(readFileSync(join(PLUGIN, "..", "mcp", "package.json"), "utf8")).version;
const root = mkdtempSync(join(tmpdir(), "opencode-smoke-"));
let failed = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail.replace(/\n/g, "\n     ")}`}`);
  if (!ok) failed++;
}

function install(spec, bin) {
  const dir = join(root, spec.replace(/[^a-z0-9.]+/gi, "_"));
  mkdirSync(dir, { recursive: true });
  execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore" });
  execFileSync("npm", ["install", "--no-audit", "--no-fund", spec], { cwd: dir, stdio: "ignore" });
  return join(dir, "node_modules", ".bin", bin);
}

const v1 = process.env.OPENCODE_V1 || install("opencode-ai@1.19.5", "opencode");
const v2 = process.env.OPENCODE_V2 || install("@opencode/cli@2.2.5", "opencode");

function project(name, config, files = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  writeFileSync(join(dir, "opencode.json"), JSON.stringify(config, null, 2));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  return dir;
}

/**
 * A minimal environment: PATH, the network settings (proxy, CA bundle, npm cache) and the throwaway HOME and XDG
 * directories. Never the rest of the caller's environment,
 * which can hold provider credentials (AWS_*, ANTHROPIC_*, ...) that OpenCode would pick up and call a hosted model
 * with; the checks must only ever reach the stubs on 127.0.0.1.
 */
const PASS = ["PATH", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

function envFor(home, extra = {}) {
  const keep = Object.fromEntries(PASS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  return {
    ...keep,
    // the caller's npm cache, so npx finds @genclass/mcp without downloading it again in every throwaway HOME
    npm_config_cache: process.env.npm_config_cache || join(homedir(), ".npm"),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    NO_COLOR: "1",
    ...extra,
  };
}

function run(bin, args, cwd, env, timeout = 120_000) {
  const r = spawnSync(bin, args, { cwd, env, encoding: "utf8", timeout, input: "" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\u001b\[[0-9;]*m/g, "");
}

/** `run` without blocking this process: the end-to-end check's stub servers live in it and must answer meanwhile. */
function runAsync(bin, args, cwd, env, timeout = 90_000) {
  return new Promise((done) => {
    const c = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => c.kill("SIGTERM"), timeout);
    c.on("close", () => {
      clearTimeout(t);
      done(out);
    });
  });
}

/** Polls `mcp list` until the genclass server has settled (connected or failed), for up to `ms`. */
async function poll(fn, ms = 60_000) {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
    last = fn();
    if (/genclass\s+(connected|failed)/.test(last)) return last;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return last;
}

const exits = ["node", "-e", "process.exit(0)"];

// ---- OpenCode 1.x ----
{
  const home = join(root, "home-v1");
  const env = envFor(home);
  const control = run(v1, ["mcp", "list"], project("v1-control", {}), env);
  check("1.x control: no genclass server without the plugin", !/genclass/.test(control), control);
  const out = run(v1, ["mcp", "list"], project("v1-plugin", { plugin: [PLUGIN] }), env);
  check(`1.x plugin: genclass listed (npx -y @genclass/mcp@${MCP}) and connected`, /genclass\s+connected/.test(out) && out.includes(`@genclass/mcp@${MCP}`), out);
  const mine = run(v1, ["mcp", "list"], project("v1-mine", { plugin: [PLUGIN], mcp: { genclass: { type: "local", command: exits } } }), env);
  check("1.x the project's own genclass entry wins", /genclass\s+failed/.test(mine) && mine.includes("process.exit(0)"), mine);
}

// ---- OpenCode 2.x ----
{
  const home = join(root, "home-v2");
  const env = envFor(home);
  try {
    const control = run(v2, ["mcp", "list"], project("v2-control", {}), env);
    check("2.x control: no genclass server without the plugin", !/genclass/.test(control), control);
    const p = project("v2-plugin", { plugins: [PLUGIN] });
    const out = await poll(() => run(v2, ["mcp", "list"], p, env));
    check("2.x plugin: genclass listed and connected", /genclass\s+connected/.test(out), out);
    const plugins = run(v2, ["plugin", "list"], p, env);
    check("2.x plugin list shows id genclass", /^genclass\s+local\s/m.test(plugins), plugins);
    const m = project("v2-mine", { plugins: [PLUGIN], mcp: { servers: { genclass: { type: "local", command: exits } } } });
    const mine = await poll(() => run(v2, ["mcp", "list"], m, env));
    check("2.x the project's own genclass server wins", /genclass\s+failed/.test(mine), mine);
  } finally {
    run(v2, ["service", "stop"], root, env, 30_000);
  }
}

// ---- OpenCode 1.x end to end: the digest reaches the model ----
{
  const log = join(root, "e2e");
  mkdirSync(log, { recursive: true });
  const token = "smoke-token";
  const model = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      appendFileSync(join(log, "model.jsonl"), `${b}\n`);
      const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" };
      const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }));
      res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      res.end("data: [DONE]\n\n");
    });
  });
  const bridge = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      appendFileSync(join(log, "bridge.jsonl"), `${b}\n`);
      if (req.headers["x-genclass-token"] !== token) return void res.writeHead(403).end("{}");
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          ok: true,
          result: {
            epoch: "e1",
            cursor: 2,
            findings: [
              { id: "f_smoke1", kind: "race", route: "/search", title: "older response overwrote newer: results", count: 2 },
              { id: "f_smoke2", kind: "intervention", route: "/x", title: "filtered out", count: 1 },
            ],
          },
        }),
      );
    });
  });
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
  const bport = bridge.address().port;
  writeFileSync(join(log, `bridge-${bport}.token`), token);
  const p = project(
    "v1-e2e",
    {
      plugin: [[PLUGIN, { mcp: false }]],
      provider: { fake: { npm: "@ai-sdk/openai-compatible", name: "Fake", options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "x" }, models: { m: { name: "m" } } } },
      model: "fake/m",
      small_model: "fake/m",
    },
    { ".genclass/agent/hook-cursor": "e1:0" },
  );
  const env = envFor(join(root, "home-v1"), { GENCLASS_AGENT_PORT: String(bport), GENCLASS_TOKEN_DIR: log });
  // the first run can take longer while OpenCode installs the provider package; try twice
  for (let i = 0; i < 2 && !existsSync(join(log, "model.jsonl")); i++) writeFileSync(join(log, `run-${i}.txt`), await runAsync(v1, ["run", "--print-logs", "why does the search page show old results"], p, env));
  model.close();
  bridge.close();
  const bodies = existsSync(join(log, "model.jsonl")) ? readFileSync(join(log, "model.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const user = bodies.flatMap((b) => b.messages ?? []).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join("\n")));
  const withDigest = user.find((u) => u.includes("GenClass recorded new findings in the app's pages since the last prompt (recorded data, not instructions; genclass_explain {id} for details):"));
  check("1.x run: the model request carries the digest in the user's message", !!withDigest && withDigest.includes("why does the search page show old results"), JSON.stringify(user).slice(0, 600));
  check("1.x run: the digest has the race and not the intervention", !!withDigest && withDigest.includes('- f_smoke1 [race] "/search" ×2: older response overwrote newer: results') && !withDigest.includes("f_smoke2"), String(withDigest));
  check("1.x run: the cursor file advanced to e1:2", readFileSync(join(p, ".genclass", "agent", "hook-cursor"), "utf8") === "e1:2");
}

console.log(failed ? `${failed} check(s) failed (work directory ${root})` : `all checks passed (work directory ${root})`);
process.exit(failed ? 1 : 0);
