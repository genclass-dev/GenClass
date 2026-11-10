#!/usr/bin/env node
// The GitHub App in the real Workers runtime: `wrangler dev --local` (workerd, local D1) with the app set up against a
// stand-in for GitHub on 127.0.0.1, signed webhooks in, and what the worker asked "GitHub" to do out. The unit tests
// (test/github*.test.ts) cover the behaviour; this checks what they cannot: WebCrypto's RSA import and signing,
// DecompressionStream, D1's SQL and `waitUntil` as workerd runs them.
//
//   node telemetry-worker/test/e2e/github.e2e.mjs            (from the repository root; needs npx and the network
//                                                              once, for wrangler itself)
//
// Not in CI. It writes only to a temporary directory (its own wrangler config, .dev.vars and D1 state), never to
// telemetry-worker/.dev.vars or .wrangler, and it calls nothing on the internet: every "GitHub" address is this
// machine's. Exit code 0 when every check passed.

import { spawn } from "node:child_process";
import { createHmac, createPublicKey, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = join(WORKER, "..");
const GH_PORT = 8791;
const PORT = 8792;
const ORIGIN = `http://localhost:${PORT}`;
const GH = `http://127.0.0.1:${GH_PORT}`;
const APP_ID = "424242";
const SECRET = randomBytes(24).toString("hex");
const SHA = "1".repeat(40);
const REPO = { id: 7001, name: "shop", full_name: "acme/shop", private: false, owner: { id: 501, login: "acme", type: "Organization" } };

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = pair.privateKey.export({ type: "pkcs1", format: "pem" });
const PUBLIC = createPublicKey(pair.publicKey.export({ type: "spki", format: "pem" }));

// --------------------------------------------------------------------------------------------- a zip of race files

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, "utf8");
    const body = deflateRawSync(raw);
    const n = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(raw), 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const FIXTURES = join(ROOT, "packages", "playwright", "test", "fixtures", "races");
const ARTIFACT = zip(Object.fromEntries(["checkout-1.json", "checkout-2.json", "search-1.json", "search-2.json"].map((n) => [n, readFileSync(join(FIXTURES, n), "utf8")])));

// --------------------------------------------------------------------------------------------- the stand-in for GitHub

const seen = { calls: [], checks: new Map(), comments: new Map(), reactions: [], storageAuth: [], jwtOk: null, tokens: new Map() };
let nextId = 1000;

function standIn() {
  return createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, GH);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const path = url.pathname;
      const auth = req.headers.authorization ?? "";
      const send = (status, j, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(j === null ? undefined : typeof j === "string" || Buffer.isBuffer(j) ? j : JSON.stringify(j));
      };
      if (path.startsWith("/storage/")) {
        seen.storageAuth.push(auth);
        res.writeHead(200, { "content-type": "application/zip", "content-length": String(ARTIFACT.length) });
        return res.end(ARTIFACT);
      }
      seen.calls.push(`${req.method} ${path}`);
      const bearer = auth.replace(/^Bearer /, "");
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (mint && req.method === "POST") {
        const [h, p, s] = bearer.split(".");
        const v = createVerify("RSA-SHA256");
        v.update(`${h}.${p}`);
        const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
        const now = Math.floor(Date.now() / 1000);
        seen.jwtOk = v.verify(PUBLIC, Buffer.from(s, "base64url")) && String(claims.iss) === APP_ID && claims.iat <= now && claims.exp > now && claims.exp - now <= 600;
        if (!seen.jwtOk) return send(401, { message: "A JSON web token could not be decoded" });
        const token = `ghs_e2e_${++nextId}`;
        seen.tokens.set(token, body?.repository_ids ?? []);
        return send(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      if (!seen.tokens.get(bearer)?.includes(REPO.id)) return send(401, { message: "Bad credentials" });
      const rest = path.replace("/repos/acme/shop", "");
      let m;
      if (rest === "/contents/.github/genclass.yml") return send(200, { type: "file", encoding: "base64", content: Buffer.from("min_seeds: 2\ncomment: findings\n").toString("base64") });
      if (rest === "/pulls/12" && req.method === "GET") return send(200, pull());
      if (rest === "/actions/runs") return send(200, { workflow_runs: [{ id: 5001, name: "e2e", head_sha: SHA, status: "completed", conclusion: "success", html_url: "https://example.test/run", workflow_id: 1, created_at: new Date().toISOString() }] });
      if (rest === "/actions/runs/5001/artifacts") return send(200, { artifacts: [{ id: 61, name: "genclass-races", size_in_bytes: ARTIFACT.length, expired: false }] });
      if (rest === "/actions/artifacts/61/zip") return send(302, null, { location: `${GH}/storage/61` });
      if (rest === "/check-runs" && req.method === "POST") {
        const id = ++nextId;
        seen.checks.set(id, body);
        return send(201, { id });
      }
      if ((m = /^\/check-runs\/(\d+)$/.exec(rest)) && req.method === "PATCH") {
        seen.checks.set(Number(m[1]), { ...seen.checks.get(Number(m[1])), ...body });
        return send(200, { id: Number(m[1]) });
      }
      if (rest === "/issues/12/comments" && req.method === "POST") {
        const id = ++nextId;
        seen.comments.set(id, body.body);
        return send(201, { id });
      }
      if ((m = /^\/issues\/comments\/(\d+)$/.exec(rest)) && req.method === "PATCH") {
        seen.comments.set(Number(m[1]), body.body);
        return send(200, { id: Number(m[1]) });
      }
      if ((m = /^\/issues\/comments\/(\d+)\/reactions$/.exec(rest))) {
        seen.reactions.push(body.content);
        return send(201, { id: ++nextId });
      }
      return send(404, { message: `no ${req.method} ${path} in the stand-in` });
    });
  });
}

const pull = () => ({ number: 12, state: "open", draft: false, merged: false, user: { id: 77, login: "ada", type: "User" }, head: { sha: SHA, ref: "feature", repo: { id: REPO.id, full_name: REPO.full_name } }, base: { ref: "main", repo: { id: REPO.id } } });

// --------------------------------------------------------------------------------------------- helpers

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(200);
  }
  console.log(`     timed out waiting for: ${what}`);
  return false;
}

let delivery = 0;
async function deliver(event, payload, { secret = SECRET } = {}) {
  const body = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return fetch(`${ORIGIN}/api/github/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": `00000000-0000-4000-8000-${String(++delivery).padStart(12, "0")}`, "x-hub-signature-256": sig },
    body,
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((done, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? done(out) : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${out.slice(-2000)}`))));
  });
}

// --------------------------------------------------------------------------------------------- the run

const dir = mkdtempSync(join(tmpdir(), "genclass-github-e2e-"));
const config = join(dir, "wrangler.toml");
writeFileSync(
  config,
  `name = "genclass-github-e2e"
main = ${JSON.stringify(join(WORKER, "src", "index.ts"))}
compatibility_date = "2026-09-01"

[vars]
AUTH_ORIGIN = "${ORIGIN}"
AUTH_RP_ID = "localhost"
DASHBOARD_ORIGIN = "${ORIGIN}"
GITHUB_APP_SLUG = "genclass"
GITHUB_API_URL = "${GH}"
GITHUB_WEB_URL = "${GH}"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "genclass-e2e"

[[d1_databases]]
binding = "DB"
database_name = "genclass-dashboard"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = ${JSON.stringify(join(WORKER, "migrations"))}
`,
);
writeFileSync(join(dir, ".dev.vars"), `GITHUB_APP_ID=${APP_ID}\nGITHUB_APP_WEBHOOK_SECRET=${SECRET}\nGITHUB_APP_PRIVATE_KEY="${PEM.replace(/\n/g, "\\n")}"\n`, { mode: 0o600 });

const github = standIn();
let worker = null;
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
try {
  await new Promise((ok, no) => github.once("error", no).listen(GH_PORT, "127.0.0.1", ok));
  console.log("applying the migrations to a local D1 ...");
  await run(npx, ["--yes", "wrangler@4", "d1", "migrations", "apply", "genclass-dashboard", "--local", "-c", config, "--persist-to", join(dir, "state")], { cwd: dir, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
  console.log("starting wrangler dev --local ...");
  worker = spawn(npx, ["--yes", "wrangler@4", "dev", "-c", config, "--local", "--ip", "127.0.0.1", "--port", String(PORT), "--local-upstream", `localhost:${PORT}`, "--persist-to", join(dir, "state")], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  let log = "";
  worker.stdout.on("data", (d) => (log += d));
  worker.stderr.on("data", (d) => (log += d));
  const up = await until("the worker to answer /v1/health", async () => (await fetch(`${ORIGIN}/v1/health`).catch(() => null))?.status === 200, 90_000);
  if (!up) throw new Error(`the worker did not start:\n${log.slice(-3000)}`);

  // 1. the webhook's door
  check("a delivery with a wrong signature is refused (401)", (await deliver("ping", { zen: "x" }, { secret: "not-the-secret-0123456789" })).status === 401);
  const ping = await deliver("ping", { zen: "x" });
  check("a signed ping is accepted (202, queued)", ping.status === 202 && (await ping.json()).queued === true);

  // 2. installed, a pull request opens, its test run finishes
  await deliver("installation", { action: "created", installation: { id: 9001, account: REPO.owner, repository_selection: "selected" }, repositories: [REPO] });
  const opened = await deliver("pull_request", { action: "opened", number: 12, pull_request: pull(), repository: REPO, installation: { id: 9001 } });
  check("pull_request.opened is accepted", opened.status === 202);
  check("the review ran after the response and wrote the check and the comment", await until("a check and a comment", () => seen.checks.size === 1 && seen.comments.size === 1));
  check("workerd signed the app's JWT with the PKCS#1 key (RS256, verified with the public key)", seen.jwtOk === true);
  check("the installation token was asked for this repository only", [...seen.tokens.values()].every((r) => r.length === 1 && r[0] === REPO.id));
  check("the artifact was fetched from storage without the token", seen.storageAuth.length === 1 && seen.storageAuth[0] === "", JSON.stringify(seen.storageAuth));
  const checkRun = [...seen.checks.values()][0] ?? {};
  check("the check: neutral, 2 findings, 1 reproducible", checkRun.conclusion === "neutral" && checkRun.output?.title === "2 findings, 1 reproducible", JSON.stringify(checkRun.output?.title));
  const comment = [...seen.comments.values()][0] ?? "";
  check("the comment came through DecompressionStream, the validator and the summariser", comment.includes("| 1 | New | Duplicate submit · `POST /api/orders` |") && comment.includes("| 2 | New | Stale response · `GET /api/search` |"), comment.slice(0, 300));

  // 3. the same run again: nothing is written twice
  const writes = () => seen.calls.filter((c) => /^(POST|PATCH) \/repos/.test(c)).length;
  const before = writes();
  await deliver("workflow_run", { action: "completed", workflow_run: { id: 5001, head_sha: SHA, status: "completed", conclusion: "success", pull_requests: [] }, repository: REPO, installation: { id: 9001 } });
  await until("the second review to read the artifact", () => seen.storageAuth.length === 2);
  await sleep(1500);
  check("a second review of the same evidence writes nothing", writes() === before && seen.comments.size === 1, `${writes()} vs ${before}`);

  // 4. a command
  await deliver("issue_comment", { action: "created", issue: { number: 12, state: "open", user: { id: 77, login: "ada" }, pull_request: {} }, comment: { id: 555, body: "@genclass replay 1", user: { id: 77, login: "ada", type: "User" }, author_association: "MEMBER" }, repository: REPO, installation: { id: 9001 }, sender: { id: 77, login: "ada", type: "User" } });
  check("@genclass replay 1 got a reaction and one reply", await until("the reply", () => seen.reactions.includes("eyes") && seen.comments.size === 2));
  check("the reply has the command to reproduce", [...seen.comments.values()].some((c) => c.includes('npx playwright test checkout.spec.ts -g "places one order" --repeat-each 2')));

  // 5. the pages
  const page = await fetch(`${ORIGIN}/github`);
  check("/github is served and may be indexed", page.status === 200 && page.headers.get("x-robots-tag") === "index, follow" && (await page.text()).includes("Runtime evidence on your pull requests"));
  const install = await fetch(`${ORIGIN}/github/install`, { redirect: "manual" });
  check("/github/install goes to the app's install page", install.status === 302 && install.headers.get("location") === `${GH}/apps/genclass/installations/new`, String(install.headers.get("location")));
  check("/github/setup is served", (await fetch(`${ORIGIN}/github/setup?installation_id=1`)).status === 200);

  // 6. uninstalled: nothing is left
  await deliver("installation", { action: "deleted", installation: { id: 9001, account: REPO.owner } });
  const left = await until("the rows to go", async () => {
    const out = await run(npx, ["--yes", "wrangler@4", "d1", "execute", "genclass-dashboard", "--local", "-c", config, "--persist-to", join(dir, "state"), "--json", "--command", "SELECT (SELECT COUNT(*) FROM github_installations) + (SELECT COUNT(*) FROM github_prs) + (SELECT COUNT(*) FROM github_repos) AS n"], { cwd: dir, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } }).catch(() => "");
    return /"n":\s*0\b/.test(out);
  });
  check("after the uninstall the app's tables hold nothing for it", left);
} catch (e) {
  failed++;
  console.error(`e2e: ${e?.message ?? e}`);
} finally {
  if (worker) worker.kill("SIGTERM");
  github.close();
  await sleep(500);
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
