// Facts about a project folder for `genclass suggest`, read from disk and from git. No network.
//
// Invariants:
// - Nothing here throws to the caller: every fs read and git call is wrapped, and a failure leaves that fact null,
//   false or empty.
// - No secret value is ever returned. A found secret is { file, line, kind }; strings copied out of the project
//   (scripts, dependency versions, the git remote, the homepage) pass through redactSecrets first.
// - The result is plain JSON data (no functions, no class instances), so tests and checks can build one by hand.
// - Bounded work: at most `maxFiles` paths are listed (default 4000), at most 200 KB is read from any file, and at
//   most 1500 files are opened for their content. Lock files, binary files and minified files are not scanned.
// - Read only: nothing is written, and git runs with optional locks off.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * @typedef {Object} RepoFacts
 * @property {string} dir  the project folder, as an absolute path
 * @property {string} name  package.json name, else the folder's name
 * @property {{ repo: boolean, tracked: string[] | null, remote: string | null, github: string | null, branch: string | null }} git
 *   tracked: paths git tracks under `dir` (null when git could not list them); remote: the origin address with any
 *   sign-in part removed; github: "owner/name" parsed from an https or ssh GitHub remote
 * @property {string[]} files  relative posix paths, capped, without node_modules, .git and build output folders
 * @property {boolean} truncated  the folder holds more files than the cap
 * @property {{ name: string | null, scripts: Record<string, string>, deps: Record<string, string>, engines: Record<string, string> | null, homepage: string | null } | null} pkg
 *   deps: dependencies and devDependencies together; null when there is no readable package.json
 * @property {"npm" | "pnpm" | "yarn" | "bun" | null} lockfile
 * @property {{ files: number, script: string | null, playwright: boolean, runner: string | null }} tests
 *   script: the "test" script unless it is npm's default "no test specified"; runner: vitest, jest, playwright,
 *   cypress, mocha or node:test
 * @property {{ workflows: { file: string, onPullRequest: boolean, runsTests: boolean, deploys: boolean }[], other: string[] }} ci
 *   workflows: GitHub Actions files; other: config files of other CI services, such as ".gitlab-ci.yml"
 * @property {{ files: string[], tracked: string[], example: boolean, ignored: boolean | null }} env
 *   files: the .env* files present; tracked: .env files git tracks that are not examples; example: an example file
 *   exists; ignored: .gitignore covers .env (null when there is no .gitignore and no git repository)
 * @property {{ file: string, line: number, kind: string }[]} secrets
 *   in tracked files only (in all files except .env files when the folder is not a git repository). Kinds:
 *   "stripe-secret-live", "stripe-secret-test", "openai-key", "anthropic-key", "aws-access-key", "github-token",
 *   "private-key", "slack-token", "generic-secret"
 * @property {{ provider: "stripe" | "paddle" | "lemonsqueezy" | "polar" | "paypal" | null, testKeyInProduction: string[], secretInClient: string[] }} payments
 *   testKeyInProduction: production env files or hosting config that hold pk_test_ or sk_test_; secretInClient:
 *   client source files that hold sk_live_ or sk_test_
 * @property {{ provider: "vercel" | "netlify" | "cloudflare" | "fly" | "render" | "railway" | "github-pages" | "firebase" | "docker" | null, previews: boolean | null, staging: boolean | null }} hosting
 *   previews: true when the host builds a copy per pull request, null when that cannot be told; staging: true when
 *   the project shows a staging setup, false when the host is known and has none, null when it cannot be told
 * @property {{ exists: boolean, chars: number, boilerplate: boolean }} readme
 * @property {{ genclass: boolean, sentry: boolean, other: string[] }} monitoring
 * @property {{ robots: boolean, sitemap: boolean, llms: boolean, ogImage: boolean, manifest: boolean }} seo
 * @property {{ url: string | null, from: string | null }} site  the production address, guessed
 */

const MAX_FILES = 4000;
const MAX_DIRS = 20000;
const MAX_READ = 200 * 1024;
const MAX_SCAN = 1500;
const MAX_SECRETS = 100;
const MAX_LISTED = 50;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".output", "coverage", ".vercel", ".turbo", "vendor"]);
const LOCK_FILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "composer.lock", "Gemfile.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "go.sum", "flake.lock", "deno.lock"]);
const BINARY_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "icns", "bmp", "tif", "tiff", "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "avi", "webm", "wav", "ogg", "flac", "wasm", "node", "exe", "dll", "so", "dylib", "bin", "dat", "db", "sqlite", "sqlite3", "jar", "class", "pyc", "o", "a", "lockb", "psd", "sketch", "fig", "onnx", "pt", "pth", "safetensors", "npy", "npz", "parquet"]);
const CODE_EXT = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro", "html", "htm"]);
const MINIFIED_NAME = /\.min\.[a-z]+$|\.map$|[.-]bundle\.js$|\.chunk\.js$/i;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__|mocks?|__mocks__|examples?|testdata|e2e|specs?)\/|\.(?:test|spec)\./i;

const ENV_FILE = /^\.env(?:\.[A-Za-z0-9_.-]+)?$/;
const EXAMPLE_ENV = /^\.env(?:\.[\w-]+)*\.(?:example|sample|template|dist)(?:\.[\w-]+)*$|^\.env[-_](?:example|sample|template)$|^env\.(?:example|sample|template)$|^(?:example|sample|template)\.env$/i;
const PROD_ENV = /^\.env\.(?:production|prod)(?:\.local)?$/i;
const STAGING_ENV = /^\.env\.(?:staging|stage|preview)(?:\.local)?$/i;
const HOSTING_CONFIG = new Map([
  ["vercel.json", "vercel"],
  ["netlify.toml", "netlify"],
  ["wrangler.toml", "cloudflare"],
  ["wrangler.json", "cloudflare"],
  ["wrangler.jsonc", "cloudflare"],
  ["fly.toml", "fly"],
  ["render.yaml", "render"],
  ["railway.json", "railway"],
  ["railway.toml", "railway"],
  ["firebase.json", "firebase"],
  [".firebaserc", "firebase"],
]);
const HOSTING_DEPS = [
  ["vercel", /^vercel$|^@vercel\/|adapter-vercel$|^@astrojs\/vercel$/],
  ["netlify", /^netlify-cli$|^@netlify\/|adapter-netlify$|^@astrojs\/netlify$/],
  ["cloudflare", /^wrangler$|^@cloudflare\/|adapter-cloudflare|^@astrojs\/cloudflare$|^@opennextjs\/cloudflare$/],
  ["firebase", /^firebase-tools$/],
  ["github-pages", /^gh-pages$/],
];
const HOSTING_WORKFLOW = [
  ["vercel", /\bvercel\b/i],
  ["netlify", /\bnetlify\b/i],
  ["cloudflare", /\bwrangler\b|cloudflare\/pages-action/i],
  ["fly", /\bflyctl\b|superfly\//i],
  ["firebase", /\bfirebase\b/i],
  ["github-pages", /actions\/deploy-pages|actions-gh-pages|github-pages-deploy-action|\bgh-pages\b/i],
];
const OTHER_CI = [".gitlab-ci.yml", ".circleci/config.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "Jenkinsfile", ".travis.yml", ".buildkite/pipeline.yml", ".drone.yml"];

const PAYMENT_DEPS = [
  ["stripe", /^stripe$|^@stripe\//],
  ["paddle", /^@paddle\/|^paddle-sdk$/],
  ["lemonsqueezy", /^@lemonsqueezy\/|^lemonsqueezy\.ts$/],
  ["polar", /^@polar-sh\//],
  ["paypal", /^@paypal\/|^paypal-rest-sdk$/],
];
const PAYMENT_ENV = [
  ["stripe", /^\s*(?:export\s+)?[A-Z0-9_]*STRIPE_/m],
  ["paddle", /^\s*(?:export\s+)?[A-Z0-9_]*PADDLE_/m],
  ["lemonsqueezy", /^\s*(?:export\s+)?[A-Z0-9_]*LEMON_?SQUEEZY_/m],
  ["polar", /^\s*(?:export\s+)?[A-Z0-9_]*POLAR_/m],
  ["paypal", /^\s*(?:export\s+)?[A-Z0-9_]*PAYPAL_/m],
];
const PAYMENT_MARKUP = [
  ["stripe", /js\.stripe\.com|(?<![A-Za-z0-9_])pk_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["paddle", /cdn\.paddle\.com/],
  ["lemonsqueezy", /lemonsqueezy\.com\/|lemon\.js/],
  ["paypal", /paypal\.com\/sdk\/js/],
];
const PAYMENT_ORDER = ["stripe", "paddle", "lemonsqueezy", "polar", "paypal"];

const MONITOR_DEPS = [
  ["posthog", /^posthog(?:-js|-node)?$|^@posthog\//],
  ["datadog", /^@datadog\/|^dd-trace$/],
  ["logrocket", /^logrocket/],
  ["bugsnag", /^@bugsnag\/|^bugsnag/],
  ["rollbar", /^rollbar$|^@rollbar\//],
  ["highlight", /^highlight\.run$|^@highlight-run\//],
];
const SENTRY_DEP = /^@sentry\/|^sentry-|^raven(?:-js)?$/;
const GENCLASS_DEP = /^@genclass\/(?:runtime|nuxt|astro|sv)$/;
const GENCLASS_MARK = /genclass:init|["']@genclass\/runtime(?:\/[\w/-]+)?["']|<script\b[^>]*genclass/i;
// Files where an app is started or its page shell is written: the places the runtime's one line goes.
const ENTRY_FILE = /\.html?$|(?:^|\/)(?:main|index|app|_app|_document|layout|root|entry|entry[.-]client|client|bootstrap|hooks\.client|\+layout|nuxt\.config|astro\.config)\.[a-z]+$/i;

const README_BOILERPLATE = [
  /^# React \+ (?:TypeScript \+ )?Vite/,
  /^# (?:Vue 3|Svelte|Preact|Solid|Lit|Qwik) \+ (?:TypeScript \+ |TS \+ )?Vite/,
  /This is a \[Next\.js\]\([^)]*\) project bootstrapped with/,
  /^# sv\s*(?:\n|$)/,
  /^# create-svelte\b/,
  /^# Nuxt(?: \d)? Minimal Starter/,
  /^# Astro Starter Kit/,
  /^# Getting Started with Create React App/,
  /^# Welcome to (?:React Router|Remix)\b/,
  /This project was generated (?:with|using) \[Angular CLI\]/,
  /^# Create T3 App/,
  /^# Welcome to your (?:Lovable project|Expo app)/,
];

const SEO_FILES = {
  robots: /(?:^|\/)robots\.txt(?:\.[cm]?[jt]s|\/\+server\.[cm]?[jt]s)?$|(?:^|\/)app\/robots\.[cm]?[jt]sx?$/,
  sitemap: /(?:^|\/)sitemap(?:[-_]index)?\.xml(?:\.[cm]?[jt]s|\/\+server\.[cm]?[jt]s)?$|(?:^|\/)app\/sitemap\.[cm]?[jt]sx?$/,
  llms: /(?:^|\/)llms(?:-full)?\.txt(?:\.[cm]?[jt]s|\/\+server\.[cm]?[jt]s)?$/,
  ogImage: /(?:^|\/)(?:og|og[-_]image|opengraph[-_]image|twitter[-_]image|social(?:[-_]?(?:card|image|preview))?|share)\.(?:png|jpe?g|webp|gif)$|(?:^|\/)app\/(?:.*\/)?(?:opengraph|twitter)-image\.[cm]?[jt]sx?$/i,
  manifest: /(?:^|\/)(?:manifest\.(?:json|webmanifest)|site\.webmanifest)$|(?:^|\/)app\/manifest\.[cm]?[jt]s$/,
};
const WEB_ROOT = /^[^/]+$|(?:^|\/)(?:public|static|app|assets)\//;
const SEO_DEPS = {
  robots: /^next-sitemap$|^@nuxtjs\/robots$|^nuxt-simple-robots$|^astro-robots-txt$|^@nuxtjs\/seo$/,
  sitemap: /^next-sitemap$|^@astrojs\/sitemap$|^@nuxtjs\/sitemap$|^nuxt-simple-sitemap$|^vite-plugin-sitemap$|^sitemap$|^svelte-sitemap$|^super-sitemap$|^@nuxtjs\/seo$/,
};

const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|e2e|specs?)\/.*\.(?:[cm]?[jt]sx?|py|go|rb)$|\.(?:test|spec|e2e|cy)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$|_spec\.rb$/;

// Secret shapes. Each is tight on purpose: a prefix a provider documents, then a long run of key characters. The
// first capture group is the part after the prefix, which is what the placeholder test looks at.
const SECRET_PATTERNS = [
  ["stripe-secret-live", /(?<![A-Za-z0-9_])[sr]k_live_([A-Za-z0-9]{16,})/g],
  ["stripe-secret-test", /(?<![A-Za-z0-9_])[sr]k_test_([A-Za-z0-9]{16,})/g],
  ["anthropic-key", /(?<![A-Za-z0-9_-])sk-ant-([A-Za-z0-9_-]{20,})/g],
  ["openai-key", /(?<![A-Za-z0-9_-])sk-(?!ant-)([A-Za-z0-9_-]{20,})/g],
  ["aws-access-key", /(?<![A-Za-z0-9])AKIA([0-9A-Z]{16})(?![0-9A-Z])/g],
  ["github-token", /(?<![A-Za-z0-9_])(?:gh[pousr]_|github_pat_)([A-Za-z0-9_]{36,})/g],
  ["slack-token", /(?<![A-Za-z0-9])xox[baprs]-([A-Za-z0-9-]{10,})/g],
];
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----(?:\\r|\\n|\s)*([A-Za-z0-9+/]{20,})/g;
const SECRET_HINT = /[sr]k_(?:live|test)_|sk-|AKIA|gh[pousr]_|github_pat_|xox[baprs]-|PRIVATE KEY-----/;
const STRIPE_SECRET = /(?<![A-Za-z0-9_])sk_(?:live|test)_([A-Za-z0-9]{16,})/g;
const STRIPE_TEST_KEY = /(?<![A-Za-z0-9_])[ps]k_test_([A-Za-z0-9]{10,})/g;
// The sample secret key printed in Stripe's public documentation: it opens nothing.
const DOCUMENTED_KEYS = new Set(["4eC39HqLyjWDarjtT1zdp7dc"]);

const PLACEHOLDER = /your|example|placeholder|change[_-]?me|replace|dummy|fake|sample|redacted|secret[_-]?here|key[_-]?here|xxxx|\*\*\*|1234567|abcdefg|\.\.\.|[<>]|\$\{|\{\{/i;
const PLACEHOLDER_VALUE = /^(?:null|undefined|none|true|false|todo|tbd|secret|password|passwd|pass|postgres|root|admin|test|testing|dev|development|local|localhost|token|key|api[_-]?key)$/i;
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
const SECRET_NAME = /(?:SECRET|TOKEN|PASSWORD|API_?KEY)$/i;
const PUBLIC_NAME = /^(?:NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|NUXT_PUBLIC_|EXPO_PUBLIC_|GATSBY_)/i;

const CODE_HOSTS = /^(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|npmjs\.com)$/i;
const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Replace anything that looks like a secret in a string with "[redacted]": provider keys, private key blocks, the
 * sign-in part of an address (https://user:token@host), NAME=value pairs and command flags whose name says secret,
 * token, password or API key, and bearer tokens. Never throws.
 * @param {unknown} value
 * @returns {string}
 */
export function redactSecrets(value) {
  try {
    let s = String(value);
    for (const [, re] of SECRET_PATTERNS) s = s.replace(re, "[redacted]");
    s = s.replace(PRIVATE_KEY, "[redacted]");
    s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1");
    s = s.replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_?KEY))=("[^"]*"|'[^']*'|[^\s"']+)/gi, "$1=[redacted]");
    s = s.replace(/(--[\w-]*(?:token|password|secret|api[-_]?key)[= ])(\S+)/gi, "$1[redacted]");
    s = s.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1[redacted]");
    return s;
  } catch {
    return "";
  }
}

/**
 * RepoFacts for a folder nothing is known about: every fact empty, false or null. `collectRepoFacts` starts from
 * this, and tests can start from it to build facts by hand.
 * @param {string} [dir]
 * @returns {RepoFacts}
 */
export function emptyRepoFacts(dir) {
  const d = typeof dir === "string" && dir ? dir : ".";
  return {
    dir: d,
    name: folderName(d),
    git: { repo: false, tracked: null, remote: null, github: null, branch: null },
    files: [],
    truncated: false,
    pkg: null,
    lockfile: null,
    tests: { files: 0, script: null, playwright: false, runner: null },
    ci: { workflows: [], other: [] },
    env: { files: [], tracked: [], example: false, ignored: null },
    secrets: [],
    payments: { provider: null, testKeyInProduction: [], secretInClient: [] },
    hosting: { provider: null, previews: null, staging: null },
    readme: { exists: false, chars: 0, boilerplate: false },
    monitoring: { genclass: false, sentry: false, other: [] },
    seo: { robots: false, sitemap: false, llms: false, ogImage: false, manifest: false },
    site: { url: null, from: null },
  };
}

/**
 * Read the facts `genclass suggest` needs from a project folder. Reads files and asks git; no network; never throws.
 * @param {string} dir  the project folder
 * @param {{ runGit?: (args: string[], cwd: string) => string | null, maxFiles?: number }} [opts]
 *        runGit returns stdout or null (default: spawnSync git with a 3 s timeout; null when git is missing or fails)
 * @returns {RepoFacts}  plain JSON-able data (no functions), so tests and checks can build it by hand
 */
export function collectRepoFacts(dir, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  let root = ".";
  try {
    root = resolve(typeof dir === "string" && dir ? dir : ".");
  } catch {
    /* keep "." */
  }
  const facts = emptyRepoFacts(root);
  const maxFiles = typeof o.maxFiles === "number" && Number.isInteger(o.maxFiles) && o.maxFiles > 0 ? o.maxFiles : MAX_FILES;
  const runGit = typeof o.runGit === "function" ? o.runGit : defaultRunGit;
  const git = (/** @type {string[]} */ args) => {
    try {
      const out = runGit(args, root);
      return typeof out === "string" ? out : null;
    } catch {
      return null;
    }
  };
  /** Shared between the steps; not returned. */
  const ctx = { root, gitRoot: root, fileSet: new Set(), trackedSet: /** @type {Set<string> | null} */ (null), workflowTexts: /** @type {{ file: string, text: string }[]} */ ([]), hints: new Set(), configText: new Map() };

  attempt(() => readGit(facts, ctx, git));
  attempt(() => {
    const listed = listFiles(root, maxFiles);
    facts.files = listed.files;
    facts.truncated = listed.truncated;
    ctx.fileSet = new Set(listed.files);
  });
  attempt(() => readPackage(facts, ctx));
  attempt(() => readLockfile(facts, ctx));
  attempt(() => readTests(facts));
  attempt(() => readCi(facts, ctx));
  attempt(() => readEnv(facts, ctx));
  attempt(() => readReadme(facts, ctx));
  attempt(() => readDeps(facts));
  attempt(() => scanContents(facts, ctx));
  attempt(() => readHosting(facts, ctx));
  attempt(() => readSeo(facts));
  attempt(() => readSite(facts, ctx));
  return facts;
}

// ---- git -----------------------------------------------------------------------------------------------------------

/** @param {string[]} args @param {string} cwd @returns {string | null} */
function defaultRunGit(args, cwd) {
  try {
    const r = spawnSync("git", args, {
      cwd,
      timeout: 3000,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
  } catch {
    return null;
  }
}

function readGit(facts, ctx, git) {
  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  const repo = (inside !== null && inside.trim() === "true") || exists(join(ctx.root, ".git"));
  facts.git.repo = repo;
  if (!repo) return;

  const cdup = git(["rev-parse", "--show-cdup"]);
  if (cdup !== null && cdup.trim()) attempt(() => (ctx.gitRoot = resolve(ctx.root, cdup.trim())));

  const listed = git(["ls-files", "-z"]);
  if (listed !== null) {
    const tracked = listed.split(listed.includes("\0") ? "\0" : /\r?\n/).filter(Boolean);
    facts.git.tracked = tracked;
    ctx.trackedSet = new Set(tracked);
  }

  let remote = git(["remote", "get-url", "origin"]);
  if (remote === null || !remote.trim()) {
    const names = git(["remote"]);
    const first = names === null ? undefined : names.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    remote = first ? git(["remote", "get-url", first]) : null;
  }
  if (remote !== null && remote.trim()) {
    const address = remote.trim().split(/\r?\n/)[0].trim();
    facts.git.github = parseGithub(address);
    facts.git.remote = redactSecrets(address);
  }

  let branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null || !branch.trim()) branch = git(["symbolic-ref", "--short", "HEAD"]);
  const name = branch === null ? "" : branch.trim();
  facts.git.branch = name && name !== "HEAD" ? name : null;
}

/** "owner/name" from a GitHub remote in https, ssh, git or scp form, with or without ".git"; else null. */
function parseGithub(remote) {
  const m = /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?(?:www\.)?github\.com(?::\d+)?\/|(?:[^@/\s]+@)?github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(remote);
  return m ? `${m[1]}/${m[2]}` : null;
}

// ---- files ---------------------------------------------------------------------------------------------------------

/** Breadth first, names sorted, so the top of the project is always listed before the cap is reached. */
function listFiles(root, maxFiles) {
  const files = [];
  let truncated = false;
  const queue = [""];
  for (let i = 0; i < queue.length && !truncated; i++) {
    if (i >= MAX_DIRS) {
      truncated = true;
      break;
    }
    const rel = queue[i];
    let entries;
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(path);
      } else if (entry.isFile()) {
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        files.push(path);
      }
    }
  }
  return { files, truncated };
}

/** The first 200 KB of a file as text (fewer bytes when `limit` says the file is smaller), or null. */
function readHead(path, limit = MAX_READ) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    const max = Math.max(0, Math.min(limit, MAX_READ));
    const buf = Buffer.allocUnsafe(max);
    let n = 0;
    while (n < max) {
      const got = readSync(fd, buf, n, max - n, null);
      if (got <= 0) break;
      n += got;
    }
    return buf.subarray(0, n).toString("utf8").replace(/^\uFEFF/, "");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** A whole text file of at most 200 KB, or null when it is larger, binary or unreadable. */
function readSmallText(path) {
  let size = 0;
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_READ) return null;
    size = st.size;
  } catch {
    return null;
  }
  const text = readHead(path, size);
  return text === null || text.includes("\0") ? null : text;
}

function exists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function attempt(fn) {
  try {
    fn();
  } catch {
    /* that fact stays as it was */
  }
}

function folderName(dir) {
  try {
    return basename(resolve(dir)) || "app";
  } catch {
    return "app";
  }
}

const baseOf = (path) => path.slice(path.lastIndexOf("/") + 1);
const extOf = (name) => (name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

// ---- package.json --------------------------------------------------------------------------------------------------

function readPackage(facts, ctx) {
  const text = readHead(join(ctx.root, "package.json"));
  if (text === null) return;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return;
  const name = typeof json.name === "string" && json.name.trim() ? json.name.trim() : null;
  const homepage = typeof json.homepage === "string" && json.homepage.trim() ? redactSecrets(json.homepage.trim()) : null;
  facts.pkg = {
    name,
    scripts: stringMap(json.scripts),
    deps: { ...stringMap(json.dependencies), ...stringMap(json.devDependencies) },
    engines: json.engines && typeof json.engines === "object" && !Array.isArray(json.engines) ? stringMap(json.engines) : null,
    homepage,
  };
  if (name) facts.name = name;
}

/** The string values of an object, redacted. A script or a dependency address can hold a token. */
function stringMap(value) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let n = 0;
  for (const key of Object.keys(value)) {
    if (typeof value[key] !== "string") continue;
    if (++n > 1000) break;
    out[redactSecrets(key)] = redactSecrets(value[key]);
  }
  return out;
}

function readLockfile(facts, ctx) {
  const dirs = ctx.gitRoot === ctx.root ? [ctx.root] : [ctx.root, ctx.gitRoot];
  const kinds = [
    ["pnpm", ["pnpm-lock.yaml"]],
    ["yarn", ["yarn.lock"]],
    ["bun", ["bun.lock", "bun.lockb"]],
    ["npm", ["package-lock.json", "npm-shrinkwrap.json"]],
  ];
  for (const dir of dirs) {
    for (const [kind, names] of kinds) {
      if (names.some((name) => exists(join(dir, name)))) {
        facts.lockfile = kind;
        return;
      }
    }
  }
}

// ---- tests and CI --------------------------------------------------------------------------------------------------

function readTests(facts) {
  const deps = facts.pkg ? facts.pkg.deps : {};
  const scripts = facts.pkg ? facts.pkg.scripts : {};
  const has = (re) => facts.files.some((f) => re.test(f));
  let count = 0;
  for (const f of facts.files) if (TEST_FILE.test(f) && !f.endsWith(".d.ts")) count++;
  const script = typeof scripts.test === "string" && scripts.test.trim() && !/no test specified/i.test(scripts.test) ? scripts.test : null;
  const playwright = "@playwright/test" in deps || "playwright" in deps || has(/(?:^|\/)playwright\.config\.[cm]?[jt]s$/);
  facts.tests = { files: count, script, playwright, runner: testRunner(script || "", deps, has, playwright) };
}

function testRunner(script, deps, has, playwright) {
  const inScript = [
    ["vitest", /\bvitest\b/],
    ["jest", /\bjest\b/],
    ["playwright", /\bplaywright\b/],
    ["cypress", /\bcypress\b/],
    ["mocha", /\bmocha\b/],
    ["node:test", /\bnode\b.*\s--test\b|node:test/],
  ];
  for (const [name, re] of inScript) if (re.test(script)) return name;
  if ("vitest" in deps || has(/(?:^|\/)vitest\.config\.[cm]?[jt]s$/)) return "vitest";
  if ("jest" in deps || "ts-jest" in deps || has(/(?:^|\/)jest\.config\.[cm]?[jt]s$/)) return "jest";
  if (playwright) return "playwright";
  if ("cypress" in deps || has(/(?:^|\/)cypress\.config\.[cm]?[jt]s$/)) return "cypress";
  if ("mocha" in deps) return "mocha";
  return null;
}

function readCi(facts, ctx) {
  const found = [];
  for (const f of facts.files) if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)) found.push({ file: f, path: join(ctx.root, f) });
  if (ctx.gitRoot !== ctx.root) {
    // The project is a folder inside a larger repository: its workflows live at the repository's top.
    attempt(() => {
      const dir = join(ctx.gitRoot, ".github", "workflows");
      for (const name of readdirSync(dir).sort()) {
        if (/\.ya?ml$/.test(name)) found.push({ file: `.github/workflows/${name}`, path: join(dir, name) });
      }
    });
  }
  for (const { file, path } of found.slice(0, MAX_LISTED)) {
    const text = readHead(path);
    if (text === null) continue;
    ctx.workflowTexts.push({ file, text });
    facts.ci.workflows.push({ file, onPullRequest: onPullRequest(text), runsTests: runsTests(text), deploys: /\bdeploy|\b(?:vercel|netlify|wrangler|flyctl|firebase)\b|gh-pages/i.test(stripYamlComments(text)) });
  }
  const dirs = ctx.gitRoot === ctx.root ? [ctx.root] : [ctx.root, ctx.gitRoot];
  for (const name of OTHER_CI) if (dirs.some((dir) => exists(join(dir, name)))) facts.ci.other.push(name);
}

const stripYamlComment = (line) => line.replace(/(^|\s)#.*$/, "$1");
const stripYamlComments = (text) => text.split(/\r?\n/).map(stripYamlComment).join("\n");

/** Whether the workflow's top-level `on:` names pull_request (as a word, a list item or a key). */
function onPullRequest(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:on|"on"|'on')\s*:(.*)$/.exec(lines[i]);
    if (!m) continue;
    let block = stripYamlComment(m[1]);
    for (let j = i + 1; j < lines.length; j++) {
      if (/^[^\s#]/.test(lines[j])) break;
      block += `\n${stripYamlComment(lines[j])}`;
    }
    return /(?:^|[\s[,'"-])pull_request(?:_target)?(?=$|[\s\],:'"])/m.test(block);
  }
  return false;
}

const DIRECT_TEST = /\b(?:vitest|jest|mocha|pytest|phpunit|rspec)\b|\bplaywright\s+test\b|\bcypress\s+run\b|\bnode\b[^\n]*\s--test\b|\b(?:go|cargo|deno|bun|dotnet|mix|flutter|gradle|mvn)\s+test\b|cypress-io\/github-action/i;
const TEST_SCRIPT_NAME = /(?:^|[:._-])(?:tests?|e2e|spec|unit)(?:$|[:._-])/i;

/** Whether a workflow runs tests: a test runner by name, or a package manager running a script named like a test. */
function runsTests(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = stripYamlComment(raw);
    if (DIRECT_TEST.test(line)) return true;
    for (const part of line.split(/&&|\|\||[|;]/)) {
      const m = /\b(?:npm|pnpm|yarn|bun|turbo|nx|make|just|lerna)\s+(.*)$/i.exec(part);
      if (!m) continue;
      for (const token of m[1].split(/\s+/)) {
        const word = token.replace(/^["']|["']$/g, "");
        if (!word || word.startsWith("-") || /[/@=]/.test(word)) continue;
        if (word === "t" || TEST_SCRIPT_NAME.test(word)) return true;
      }
    }
  }
  return false;
}

// ---- env files -----------------------------------------------------------------------------------------------------

function readEnv(facts, ctx) {
  const files = [];
  let example = false;
  for (const f of facts.files) {
    const base = baseOf(f);
    if (EXAMPLE_ENV.test(base)) example = true;
    if (ENV_FILE.test(base) && files.length < MAX_LISTED) files.push(f);
  }
  facts.env.files = files;
  facts.env.example = example;
  if (facts.git.tracked) {
    for (const f of facts.git.tracked) {
      const base = baseOf(f);
      if (EXAMPLE_ENV.test(base)) facts.env.example = true;
      if (!ENV_FILE.test(base) || EXAMPLE_ENV.test(base) || facts.env.tracked.length >= MAX_LISTED) continue;
      // A tracked env file that only sets values the browser is sent anyway (VITE_, NEXT_PUBLIC_) holds no secret.
      const text = readSmallText(join(ctx.root, f));
      if (text !== null && onlyPublicValues(text)) continue;
      facts.env.tracked.push(f);
    }
  }

  const dirs = ctx.gitRoot === ctx.root ? [ctx.root] : [ctx.root, ctx.gitRoot];
  let seen = false;
  let covered = false;
  for (const dir of dirs) {
    const text = readHead(join(dir, ".gitignore"));
    if (text === null) continue;
    seen = true;
    if (ignoreCoversEnv(text)) covered = true;
  }
  facts.env.ignored = seen ? covered : facts.git.repo ? false : null;
}

/** Whether every value an env file sets is empty, a placeholder, or under a name frameworks ship to the browser. */
function onlyPublicValues(text) {
  for (const line of text.split(/\r?\n/)) {
    const m = ENV_LINE.exec(line);
    if (!m || PUBLIC_NAME.test(m[1])) continue;
    const value = envValue(m[2]);
    if (value && !isPlaceholder(value) && !PLACEHOLDER_VALUE.test(value)) return false;
  }
  return true;
}

/** Whether a .gitignore covers a file named ".env": the last pattern that matches the name decides. */
function ignoreCoversEnv(text) {
  let covered = false;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    if (negated) line = line.slice(1);
    if (line.endsWith("/")) continue;
    line = line.replace(/^(?:\*\*\/)+/, "").replace(/^\//, "");
    if (!line || line.includes("/")) continue;
    if (globMatches(line, ".env")) covered = !negated;
  }
  return covered;
}

function globMatches(pattern, name) {
  let re = "";
  for (const ch of pattern) re += ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(`^${re}$`).test(name);
  } catch {
    return false;
  }
}

// ---- README, dependencies ------------------------------------------------------------------------------------------

function readReadme(facts, ctx) {
  const file = facts.files.find((f) => /^readme(?:\.(?:md|mdx|markdown|rst|txt))?$/i.test(f));
  if (!file) return;
  const text = readHead(join(ctx.root, file));
  if (text === null) return;
  const body = text.trim();
  facts.readme = { exists: true, chars: body.length, boilerplate: README_BOILERPLATE.some((re) => re.test(body)) };
}

function readDeps(facts) {
  const names = facts.pkg ? Object.keys(facts.pkg.deps) : [];
  for (const [provider, re] of PAYMENT_DEPS) {
    if (names.some((n) => re.test(n))) {
      facts.payments.provider = provider;
      break;
    }
  }
  facts.monitoring.genclass = names.some((n) => GENCLASS_DEP.test(n));
  facts.monitoring.sentry = names.some((n) => SENTRY_DEP.test(n));
  facts.monitoring.other = MONITOR_DEPS.filter(([, re]) => names.some((n) => re.test(n))).map(([name]) => name);
}

// ---- file contents: secrets, payment keys, markers -----------------------------------------------------------------

function scanContents(facts, ctx) {
  const tracked = ctx.trackedSet;
  const candidates = [];
  for (const file of facts.files) {
    const base = baseOf(file);
    const ext = extOf(base);
    if (BINARY_EXT.has(ext) || LOCK_FILES.has(base)) continue;
    const env = ENV_FILE.test(base);
    const example = EXAMPLE_ENV.test(base);
    const config = HOSTING_CONFIG.has(base);
    // Secrets are looked for in what git tracks. Without git, in every file except .env files, where they belong.
    const secrets = !example && (tracked ? tracked.has(file) : !facts.git.repo && !env);
    const prod = PROD_ENV.test(base) || config;
    const client = CODE_EXT.has(ext) && isClientSource(file);
    const markup = CODE_EXT.has(ext);
    if (!(secrets || prod || client || markup || env || example)) continue;
    candidates.push({ file, base, env, example, config, secrets, prod, client, markup, rank: env || example || prod ? 0 : client || markup ? 1 : 2 });
  }
  candidates.sort((a, b) => a.rank - b.rank);

  const seen = new Set();
  let opened = 0;
  for (const c of candidates) {
    if (opened >= MAX_SCAN) break;
    const text = readSmallText(join(ctx.root, c.file));
    if (text === null) continue;
    opened++;
    const minified = MINIFIED_NAME.test(c.base) || looksMinified(text);
    if (c.config) ctx.configText.set(c.file, text);

    if (c.env || c.example) for (const [provider, re] of PAYMENT_ENV) if (re.test(text)) ctx.hints.add(provider);
    if (c.markup && !minified) {
      for (const [provider, re] of PAYMENT_MARKUP) if (re.test(text)) ctx.hints.add(provider);
      if (ENTRY_FILE.test(c.file) && GENCLASS_MARK.test(text)) facts.monitoring.genclass = true;
      if (/browser\.sentry-cdn\.com|js\.sentry-cdn\.com/.test(text)) facts.monitoring.sentry = true;
    }
    if (c.secrets && !minified) {
      for (const hit of findSecrets(text, c.env, TEST_PATH.test(c.file))) {
        const key = `${c.file}:${hit.line}:${hit.kind}`;
        if (seen.has(key) || facts.secrets.length >= MAX_SECRETS) continue;
        seen.add(key);
        facts.secrets.push({ file: c.file, line: hit.line, kind: hit.kind });
        if (hit.kind.startsWith("stripe-")) ctx.hints.add("stripe");
      }
    }
    if (c.prod && holdsTestKey(c.base, text) && facts.payments.testKeyInProduction.length < MAX_LISTED) {
      facts.payments.testKeyInProduction.push(c.file);
      ctx.hints.add("stripe");
    }
    if (c.client && !minified && holdsStripeSecret(text) && facts.payments.secretInClient.length < MAX_LISTED) {
      facts.payments.secretInClient.push(c.file);
      ctx.hints.add("stripe");
    }
  }
  if (facts.payments.provider === null) facts.payments.provider = PAYMENT_ORDER.find((p) => ctx.hints.has(p)) || null;
}

/** Source that is built into what the browser downloads: under src, app, pages, components or public, not server code. */
function isClientSource(file) {
  if (!/(?:^|\/)(?:src|app|pages|components|public)\//.test(file)) return false;
  if (/(?:^|\/)(?:api|server|functions|backend|workers?)\//.test(file)) return false;
  if (/\.server\.|\+(?:page\.|layout\.)?server\.|(?:^|\/)(?:route|middleware)\.[cm]?[jt]s$/.test(file)) return false;
  return !TEST_PATH.test(file);
}

function looksMinified(text) {
  if (text.length < 5000) return false;
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return text.length / lines > 2000;
}

/** A value nobody could use as a key: empty, a word such as "your_key_here", or a few characters repeated. */
function isPlaceholder(body) {
  if (!body) return true;
  if (PLACEHOLDER.test(body)) return true;
  return new Set(body.toLowerCase()).size <= 4;
}

/**
 * The secrets in one file's text, as line numbers and kinds. The values are never kept.
 * @param {string} text
 * @param {boolean} envFile  a tracked .env file: NAME=value lines with a secret-looking name count too
 * @param {boolean} testPath  a test, fixture or example file: sample private keys there are not reported
 * @returns {{ line: number, kind: string }[]}
 */
function findSecrets(text, envFile, testPath) {
  const out = [];
  if (!envFile && !SECRET_HINT.test(text)) return out;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let found = false;
    if (SECRET_HINT.test(line)) {
      for (const [kind, re] of SECRET_PATTERNS) {
        for (const m of line.matchAll(re)) {
          const body = m[1];
          if (isPlaceholder(body) || DOCUMENTED_KEYS.has(body)) continue;
          // "sk-" also starts ordinary hyphenated names; a key has a digit and either a capital or a long run.
          if (kind === "openai-key" && !(/\d/.test(body) && (/[A-Z]/.test(body) || /[A-Za-z0-9]{20,}/.test(body)))) continue;
          if (kind === "slack-token" && !/\d/.test(body)) continue;
          out.push({ line: i + 1, kind });
          found = true;
          break;
        }
      }
    }
    if (envFile && !found) {
      const m = ENV_LINE.exec(line);
      if (m && SECRET_NAME.test(m[1]) && !PUBLIC_NAME.test(m[1])) {
        const value = envValue(m[2]);
        if (value && !isPlaceholder(value) && !PLACEHOLDER_VALUE.test(value)) out.push({ line: i + 1, kind: "generic-secret" });
      }
    }
  }
  if (!testPath && text.includes("PRIVATE KEY-----")) {
    for (const m of text.matchAll(PRIVATE_KEY)) {
      let line = 1;
      for (let i = text.indexOf("\n"); i !== -1 && i < m.index; i = text.indexOf("\n", i + 1)) line++;
      out.push({ line, kind: "private-key" });
    }
  }
  return out;
}

/** The value of a NAME=value line: quotes removed, and for an unquoted value the trailing comment removed. */
function envValue(raw) {
  const s = raw.trim();
  const quoted = /^(["'`])(.*)\1/.exec(s);
  return quoted ? quoted[2].trim() : s.replace(/\s+#.*$/, "").trim();
}

function holdsStripeSecret(text) {
  if (!text.includes("sk_")) return false;
  for (const m of text.matchAll(STRIPE_SECRET)) if (!isPlaceholder(m[1])) return true;
  return false;
}

/**
 * Whether a production env file or a hosting config holds a Stripe test key. Sections of a config that belong to
 * another environment ([env.staging] in wrangler.toml, [context.deploy-preview] in netlify.toml) are not counted.
 */
function holdsTestKey(base, text) {
  if (!text.includes("k_test_")) return false;
  let body = text;
  if (/^wrangler\.jsonc?$/.test(base)) {
    const json = parseJsonc(text);
    if (json && json.env && typeof json.env === "object") {
      for (const name of Object.keys(json.env)) if (!/^prod(?:uction)?$/i.test(name)) delete json.env[name];
      body = JSON.stringify(json);
    }
  }
  const toml = base.endsWith(".toml");
  let skip = false;
  for (const line of body.split(/\r?\n/)) {
    if (toml) {
      const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (header) {
        skip = /^(?:env|context)\.(?!production\b|prod\b)/i.test(header[1]);
        continue;
      }
    }
    if (skip) continue;
    for (const m of line.matchAll(STRIPE_TEST_KEY)) if (!isPlaceholder(m[1])) return true;
  }
  return false;
}

/** JSON with comments and trailing commas (wrangler.jsonc), or null. */
function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

// ---- hosting -------------------------------------------------------------------------------------------------------

function readHosting(facts, ctx) {
  const names = facts.pkg ? Object.keys(facts.pkg.deps) : [];
  const scripts = facts.pkg ? facts.pkg.scripts : {};
  const workflows = ctx.workflowTexts.map((w) => stripYamlComments(w.text));
  const configFile = (base) => facts.files.find((f) => f === base) || facts.files.find((f) => baseOf(f) === base);

  let provider = null;
  for (const [base, name] of HOSTING_CONFIG) {
    if (configFile(base)) {
      provider = name;
      break;
    }
  }
  if (!provider && exists(join(ctx.root, ".vercel"))) provider = "vercel";
  if (!provider && exists(join(ctx.root, ".netlify"))) provider = "netlify";
  if (!provider) for (const [name, re] of HOSTING_DEPS) if (!provider && names.some((n) => re.test(n))) provider = name;
  if (!provider) for (const [name, re] of HOSTING_WORKFLOW) if (!provider && workflows.some((t) => re.test(t))) provider = name;
  if (!provider && facts.files.some((f) => /^(?:Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(f))) provider = "docker";

  const configs = (re) => {
    const out = [];
    for (const [file, text] of ctx.configText) if (re.test(baseOf(file))) out.push({ base: baseOf(file), text });
    return out;
  };
  const wranglerEnvs = [];
  for (const { base, text } of configs(/^wrangler\./)) {
    if (base.endsWith(".toml")) {
      for (const m of text.matchAll(/^\s*\[\[?\s*env\.([A-Za-z0-9_-]+)/gm)) wranglerEnvs.push(m[1]);
    } else {
      const json = parseJsonc(text);
      if (json && json.env && typeof json.env === "object") wranglerEnvs.push(...Object.keys(json.env));
    }
  }
  const otherEnvs = wranglerEnvs.filter((name) => !/^prod(?:uction)?$/i.test(name));

  let previews = null;
  if (provider === "vercel" || provider === "netlify") previews = true;
  else if (provider === "cloudflare" && otherEnvs.length) previews = true;
  else if (provider === "render" && configs(/^render\.yaml$/).some(({ text }) => /^\s*previews\s*:|pullRequestPreviewsEnabled\s*:\s*true|previewsEnabled\s*:\s*true/m.test(text))) previews = true;
  else if (provider === "fly" && workflows.some((t) => /fly-pr-review-apps/.test(t))) previews = true;
  else if (provider === "firebase" && ctx.workflowTexts.some((w) => /action-hosting-deploy/.test(w.text) && onPullRequest(w.text))) previews = true;

  const signs =
    otherEnvs.some((name) => /^(?:staging|stage|preview|qa|test|dev|development|beta|canary)$/i.test(name)) ||
    facts.files.some((f) => STAGING_ENV.test(baseOf(f)) || /(?:^|[./_-])staging(?:[./_-]|$)/i.test(f)) ||
    configs(/^netlify\.toml$/).some(({ text }) => /^\s*\[context\.(?:staging|branch-deploy)/m.test(text)) ||
    workflows.some((t) => /\bstaging\b/i.test(t)) ||
    Object.keys(scripts).some((name) => /staging/i.test(name) || /staging/i.test(scripts[name]));
  // These four hosts make no test copy unless the project sets one up, so finding none is a fact. For the others
  // (and when the host is unknown) the setting lives in a dashboard this module cannot see.
  const staging = signs ? true : provider === "github-pages" || provider === "fly" || provider === "render" || provider === "firebase" ? (previews ? null : false) : null;

  facts.hosting = { provider, previews, staging };
}

// ---- search files, site address ------------------------------------------------------------------------------------

function readSeo(facts) {
  const names = facts.pkg ? Object.keys(facts.pkg.deps) : [];
  const has = (re, webRootOnly) => facts.files.some((f) => re.test(f) && (!webRootOnly || WEB_ROOT.test(f)) && !TEST_PATH.test(f));
  facts.seo = {
    robots: has(SEO_FILES.robots, false) || names.some((n) => SEO_DEPS.robots.test(n)),
    sitemap: has(SEO_FILES.sitemap, false) || names.some((n) => SEO_DEPS.sitemap.test(n)),
    llms: has(SEO_FILES.llms, false),
    ogImage: has(SEO_FILES.ogImage, true),
    manifest: has(SEO_FILES.manifest, true),
  };
}

function readSite(facts, ctx) {
  const homepage = facts.pkg ? facts.pkg.homepage : null;
  if (homepage) {
    try {
      const u = new URL(homepage);
      const local = /^(?:localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname) || u.hostname.endsWith(".local");
      if (/^https?:$/.test(u.protocol) && !CODE_HOSTS.test(u.hostname) && !local) {
        facts.site = { url: u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")), from: "package.json homepage" };
        return;
      }
    } catch {
      /* not an address */
    }
  }
  for (const file of ["CNAME", "public/CNAME", "static/CNAME", "docs/CNAME"]) {
    if (!ctx.fileSet.has(file)) continue;
    const text = readHead(join(ctx.root, file));
    const host = text === null ? "" : (text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "").toLowerCase();
    if (host.length <= 253 && HOST_NAME.test(host)) {
      facts.site = { url: `https://${host}`, from: file };
      return;
    }
  }
}
