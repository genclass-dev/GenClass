#!/usr/bin/env node
// Registers GenClass's GitHub App (genclass[bot]) from its manifest, for the owner to run (Node 20 or later, no
// dependencies). GitHub's "manifest flow": this script serves one page on 127.0.0.1 that posts the manifest to
// GitHub, you confirm the app's name there while signed in as the account or organization that will own it, GitHub
// sends your browser back here with a code, and the script exchanges the code for the app's id, slug, client id and
// its three secrets (the private key, the webhook secret, the client secret).
//
//   node scripts/github-app-setup.mjs --org genclass-dev          the real app, owned by the organization
//   node scripts/github-app-setup.mjs --name "GenClass (test)" --private --origin https://my-tunnel.example
//                                                                  a test app whose webhook points at a tunnel
//   node scripts/github-app-setup.mjs --print-manifest             print the manifest and stop
//
// What it does and does not do:
// - The manifest is telemetry-worker/github-app.manifest.json (the app's permissions and events, the same list the
//   docs and the app's own page give), with --name and --origin applied. The script adds nothing to it but the
//   address GitHub sends the code back to.
// - The secrets are never printed and never shown in the browser. They are written to one file,
//   telemetry-worker/.github-app.secrets.json (mode 0600, ignored by git), in the form
//   `npx wrangler secret bulk` reads; the script prints that command and tells you to delete the file afterwards.
//   GitHub shows these secrets once: if the file is lost before the secrets are set, generate a new private key and
//   client secret in the app's settings.
// - It registers the app and nothing else: it does not install it anywhere, does not deploy the worker, does not
//   apply the migration and does not list it on GitHub Marketplace. docs/github-app/SETUP.md has those steps.
// - It listens on 127.0.0.1 only, answers one request with a matching `state`, then stops (or after 10 minutes).
//
// Flags: --org <login> (owned by an organization; default: your own account), --name <text> (default "GenClass"),
// --origin <https origin of the collector> (default https://genclass.dev), --private (only the owner can install it),
// --port <n> (default 8976), --print-manifest, --no-open (do not open the browser).

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(ROOT, "telemetry-worker");
export const MANIFEST_FILE = join(WORKER, "github-app.manifest.json");
export const SECRETS_FILE = join(WORKER, ".github-app.secrets.json");
export const DEFAULT_ORIGIN = "https://genclass.dev";
export const DEFAULT_PORT = 8976;
const GITHUB = "https://github.com";
const API = "https://api.github.com";
const API_VERSION = /export const API_VERSION = "([^"]+)"/.exec(readFileSync(join(WORKER, "src/github/api.ts"), "utf8"))?.[1] ?? "2022-11-28";

export class SetupError extends Error {}
function fail(msg) {
  throw new SetupError(msg);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The flags, checked. Throws SetupError for anything it does not know. */
export function parseArgs(argv) {
  const o = { org: null, name: "GenClass", origin: DEFAULT_ORIGIN, public: true, port: DEFAULT_PORT, printManifest: false, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i] ?? fail(`${a} needs a value`);
    if (a === "--org") o.org = value();
    else if (a === "--name") o.name = value();
    else if (a === "--origin") o.origin = value();
    else if (a === "--port") o.port = Number(value());
    else if (a === "--private") o.public = false;
    else if (a === "--print-manifest") o.printManifest = true;
    else if (a === "--no-open") o.open = false;
    else fail(`unknown flag ${a} (see the top of scripts/github-app-setup.mjs)`);
  }
  if (o.org !== null && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(o.org)) fail("--org takes an organization's login");
  o.name = o.name.trim();
  if (!o.name || o.name.length > 34) fail("--name must be 1 to 34 characters (GitHub's limit for an app's name)");
  let origin;
  try {
    origin = new URL(o.origin);
  } catch {
    fail("--origin must be an https origin, like https://genclass.dev");
  }
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username) fail("--origin must be an https origin with no path, like https://genclass.dev");
  o.origin = origin.origin;
  if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65535) fail("--port must be a port from 1024 to 65535");
  return o;
}

/**
 * The manifest GitHub gets: the file's, with the name, whether anyone may install it, and every address moved to
 * `origin` (a test app's tunnel, or a self-hosted collector); `redirect` is where GitHub sends the code.
 */
export function buildManifest(base, o, redirect) {
  const move = (u) => {
    const url = new URL(u);
    return `${o.origin}${url.pathname}`;
  };
  return {
    ...base,
    name: o.name,
    url: move(base.url),
    hook_attributes: { ...base.hook_attributes, url: move(base.hook_attributes.url) },
    callback_urls: base.callback_urls.map(move),
    setup_url: move(base.setup_url),
    public: o.public,
    ...(redirect ? { redirect_url: redirect } : {}),
  };
}

/** Where the manifest is posted: the signed-in person's own account, or an organization they own. */
export function registerUrl(org, state) {
  return `${GITHUB}${org ? `/organizations/${org}` : ""}/settings/apps/new?state=${encodeURIComponent(state)}`;
}

/** The page that posts the manifest to GitHub (a form, as GitHub's flow requires; it submits itself). */
export function formPage(action, manifest) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Register the GenClass GitHub App</title></head>
<body>
<p>Sending the app's manifest to GitHub. If nothing happens, press the button.</p>
<form id="f" method="post" action="${esc(action)}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
<button type="submit">Continue on GitHub</button>
</form>
<script>document.getElementById("f").submit();</script>
</body></html>`;
}

const donePage = (text) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>GenClass GitHub App</title></head><body><p>${esc(text)}</p></body></html>`;

/** What GitHub returned for the code, checked: the app's public facts and its secrets, apart. */
export function readConversion(app) {
  const a = app && typeof app === "object" ? app : {};
  const id = a.id;
  const slug = a.slug;
  if (!Number.isSafeInteger(id) || id <= 0 || typeof slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)) fail("GitHub's answer did not name an app");
  for (const k of ["pem", "webhook_secret", "client_id", "client_secret"]) if (typeof a[k] !== "string" || !a[k]) fail(`GitHub's answer has no ${k}`);
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(a.pem)) fail("GitHub's answer has no private key");
  return {
    app: { id, slug, name: String(a.name ?? slug), url: typeof a.html_url === "string" ? a.html_url : `${GITHUB}/apps/${slug}`, owner: String(a.owner?.login ?? "") },
    secrets: {
      GITHUB_APP_ID: String(id),
      GITHUB_APP_PRIVATE_KEY: a.pem,
      GITHUB_APP_WEBHOOK_SECRET: a.webhook_secret,
      GITHUB_APP_CLIENT_ID: a.client_id,
      GITHUB_APP_CLIENT_SECRET: a.client_secret,
    },
  };
}

/** Exchange the code GitHub sent back for the app (once; a code works for an hour). */
export async function convert(code, fetchImpl) {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{8,200}$/.test(code)) fail("GitHub sent no usable code");
  let res;
  try {
    res = await fetchImpl(`${API}/app-manifests/${code}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json", "user-agent": "genclass-app-setup", "x-github-api-version": API_VERSION } });
  } catch {
    fail("GitHub did not answer the code exchange; run the script again");
  }
  if (res.status !== 201) fail(`GitHub refused the code (HTTP ${res.status}); it works once, within an hour: run the script again`);
  return readConversion(await res.json());
}

function sameState(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The local page's request handler: GET / is the form, GET /created is GitHub's way back. Returns what to answer and,
 * for the one request that carries the right state and a code that converts, the app.
 */
export function createHandler({ manifest, action, state, fetch: fetchImpl }) {
  let used = false;
  return async (method, rawUrl) => {
    const url = new URL(rawUrl, "http://127.0.0.1");
    if (method !== "GET") return { status: 405, body: donePage("Method not allowed.") };
    if (url.pathname === "/") return { status: 200, body: formPage(action, manifest) };
    if (url.pathname !== "/created") return { status: 404, body: donePage("Not found.") };
    if (used) return { status: 409, body: donePage("This page was already used. Look at the terminal.") };
    if (!sameState(url.searchParams.get("state"), state)) return { status: 400, body: donePage("This request did not come from the page this script opened. Nothing was done.") };
    used = true;
    try {
      const result = await convert(url.searchParams.get("code"), fetchImpl);
      return { status: 200, body: donePage(`The app "${result.app.name}" is registered. Go back to the terminal for the next steps; you can close this tab.`), result };
    } catch (e) {
      return { status: 502, body: donePage(e instanceof SetupError ? e.message : "The code exchange failed. Look at the terminal."), error: e };
    }
  };
}

function writeSecretsFile(secrets, file = SECRETS_FILE) {
  writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    /* the address is printed too */
  }
}

/** Serve `handler` on 127.0.0.1 until it returns a result or an error, or `timeoutMs` passes. */
function listen(handler, port, timeoutMs = 10 * 60_000) {
  return new Promise((done, reject) => {
    const server = createServer((req, res) => {
      handler(req.method ?? "GET", req.url ?? "/").then((r) => {
        res.writeHead(r.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
        res.end(r.body);
        if (r.result || r.error) {
          clearTimeout(timer);
          server.close();
          if (r.result) done(r.result);
          else reject(r.error);
        }
      });
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new SetupError("nobody came back from GitHub within 10 minutes; run the script again"));
    }, timeoutMs);
    server.on("error", (e) => reject(new SetupError(`could not listen on 127.0.0.1:${port} (${e.code ?? "error"}); try --port`)));
    server.listen(port, "127.0.0.1");
  });
}

/** What to do after the app exists. No secret appears in it. */
export function nextSteps(app, o, secretsFile) {
  const slugLine = app.slug === "genclass" ? "" : `\n   The app's URL name is "${app.slug}", not "genclass": set GITHUB_APP_SLUG = "${app.slug}" in telemetry-worker/wrangler.toml\n   (its bot is ${app.slug}[bot], and "@${app.slug}" is what people type).`;
  return `
Registered "${app.name}" (id ${app.id})${app.owner ? ` for ${app.owner}` : ""}: ${app.url}
Its secrets are in ${secretsFile} (mode 0600, ignored by git). They are shown by GitHub once.

Next, in order (docs/github-app/SETUP.md has the detail):
1. One permission the manifest cannot carry. Open ${app.url.replace("/apps/", "/settings/apps/").replace(GITHUB, o.org ? `${GITHUB}/organizations/${o.org}` : GITHUB)}/permissions,
   "Repository permissions", "Single file": Read-only, path .github/genclass.yml. Save. Without it every repository
   gets the default settings (reviews still work).${slugLine}
2. The secrets, from telemetry-worker/:
     npx --yes wrangler@4 secret bulk ${secretsFile.split("/").pop()}
   then delete the file:
     rm ${secretsFile.split("/").pop()}
3. The tables (once): check what is pending, then apply.
     CLOUDFLARE_ACCOUNT_ID=<account> npx --yes wrangler@4 d1 migrations list genclass-dashboard --remote
     CLOUDFLARE_ACCOUNT_ID=<account> npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote
4. Deploy the worker:
     npx --yes wrangler@4 deploy
5. Check: ${o.origin}/github shows the app's page; in the app's settings, "Advanced", the ping delivery to
   ${o.origin}/api/github/webhook answers 200 (redeliver it after the deploy).
6. Install it on one repository of your own and open a pull request there (SETUP.md, "First run").
`;
}

/**
 * The whole run. `fetch`, `log`, `serve`, `writeSecrets` and `open` are parameters so the tests can run it without a
 * network, a browser or a file (telemetry-worker/test/github-setup.test.ts). Throws SetupError when a check fails.
 */
export async function main({ argv = process.argv.slice(2), fetch: fetchImpl = globalThis.fetch, log = console.log, serve = listen, writeSecrets = writeSecretsFile, open = openBrowser, state = randomBytes(24).toString("base64url") } = {}) {
  const o = parseArgs(argv);
  const base = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
  const local = `http://127.0.0.1:${o.port}`;
  const manifest = buildManifest(base, o, `${local}/created`);
  if (o.printManifest) {
    log(JSON.stringify(buildManifest(base, o, null), null, 2));
    return null;
  }
  const handler = createHandler({ manifest, action: registerUrl(o.org, state), state, fetch: fetchImpl });
  log(`Registering the GitHub App "${o.name}" ${o.org ? `for the organization ${o.org}` : "for your own GitHub account"}, with its webhook at ${manifest.hook_attributes.url}.`);
  log(`Open ${local}/ in the browser where you are signed in to GitHub as its owner, and confirm the name there.`);
  if (o.open) open(`${local}/`);
  const { app, secrets } = await serve(handler, o.port);
  const file = writeSecrets(secrets);
  log(nextSteps(app, o, file));
  return app;
}

const invoked = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  main().catch((e) => {
    console.error(`github-app-setup: ${e instanceof SetupError ? e.message : (e?.stack ?? e)}`);
    process.exit(1);
  });
}
