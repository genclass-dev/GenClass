// Facts read from a project folder (src/suggest/repo.mjs): small projects built in a temp folder, a stand-in git.
import { describe, expect, it } from "vitest";
import { collectRepoFacts, emptyRepoFacts, redactSecrets } from "../src/suggest/repo.mjs";
import { isolate, tempDir, write } from "./helpers.js";

isolate();

/** A stand-in git: a repository whose tracked files are `tracked` (default: every file written), on `remote`. */
const git = (o: { remote?: string | null; tracked?: string[] | null; branch?: string } = {}) => (args: string[]) => {
  const a = args.join(" ");
  if (/rev-parse.*--is-inside-work-tree|rev-parse.*--show-toplevel|rev-parse --git-dir/.test(a)) return a.includes("--is-inside-work-tree") ? "true" : ".";
  if (/remote get-url|config --get remote\.origin\.url/.test(a)) return o.remote === undefined ? "git@github.com:acme/shop.git" : o.remote;
  if (/abbrev-ref|branch --show-current|symbolic-ref/.test(a)) return o.branch ?? "main";
  if (/ls-files/.test(a)) return o.tracked === null ? null : (o.tracked ?? []).join(a.includes("-z") ? "\0" : "\n");
  if (/check-ignore/.test(a)) return null;
  return null;
};
const noGit = () => null;

// Made here from a small fixed generator, so that no secret-shaped string is in this file and none repeats a few
// characters (the scanner reads those as placeholders, which a test below checks).
function scramble(length: number, seed: number, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"): string {
  let x = seed;
  let out = "";
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[Math.floor((x / 2147483648) * alphabet.length)];
  }
  return out;
}
const LIVE = `sk_live_${scramble(32, 11)}`;
const TEST = `sk_test_${scramble(32, 12)}`;
const PK_TEST = `pk_test_${scramble(32, 13)}`;
const OPENAI = `sk-proj-${scramble(40, 14)}`;
const ANTHROPIC = `sk-ant-api03-${scramble(40, 15)}`;
const AWS = `AKIA${scramble(16, 16, "ABCDEFGHJKLMNPQRSTUVWXYZ234567")}`;
const GH = `ghp_${scramble(36, 17)}`;
const SLACK = `xoxb-${scramble(11, 18, "23456789")}-${scramble(24, 19)}`;
const SESSION = scramble(28, 20);

describe("genclass suggest: the facts of a project (src/suggest/repo.mjs)", () => {
  it("a Next.js shop on Vercel with tests, a workflow and Stripe", () => {
    const dir = tempDir();
    write(dir, {
      "package.json": JSON.stringify({ name: "polar-parts", homepage: "https://polarparts.example", scripts: { test: "vitest run", dev: "next dev" }, engines: { node: ">=20" }, dependencies: { next: "15.0.0", react: "19.0.0", stripe: "^17.0.0", "@sentry/nextjs": "^8.0.0" }, devDependencies: { vitest: "^3.0.0", "@playwright/test": "^1.50.0" } }),
      "package-lock.json": "{}",
      "README.md": `# Polar Parts\n\n${"Parts for every sled, shipped across Canada. ".repeat(10)}\n`,
      "vercel.json": "{}",
      ".gitignore": "node_modules\n.env\n.env.*\n!.env.example\n",
      ".env": "STRIPE_SECRET_KEY=not-tracked\n",
      ".env.example": "STRIPE_SECRET_KEY=\nNEXT_PUBLIC_SITE=https://example.com\n",
      "app/page.tsx": "export default function Page() { return <h1>Polar Parts</h1>; }\n",
      "app/robots.ts": "export default function robots() { return { rules: [] }; }\n",
      "app/sitemap.ts": "export default function sitemap() { return []; }\n",
      "app/opengraph-image.png": "png",
      "public/llms.txt": "# Polar Parts\n",
      "tests/cart.test.ts": "import { test } from 'vitest';\n",
      "e2e/checkout.spec.ts": "import { test } from '@playwright/test';\n",
      ".github/workflows/ci.yml": "name: ci\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n",
      "node_modules/left-pad/index.js": "module.exports = 1;\n",
      "dist/bundle.js": "built\n",
    });
    const tracked = ["package.json", "package-lock.json", "README.md", "vercel.json", ".gitignore", ".env.example", "app/page.tsx", "app/robots.ts", "app/sitemap.ts", "app/opengraph-image.png", "public/llms.txt", "tests/cart.test.ts", "e2e/checkout.spec.ts", ".github/workflows/ci.yml"];
    const f = collectRepoFacts(dir, { runGit: git({ tracked, remote: "https://github.com/acme/polar-parts.git" }) });
    expect(f.name).toBe("polar-parts");
    expect(f.git).toMatchObject({ repo: true, remote: "https://github.com/acme/polar-parts.git", github: "acme/polar-parts", branch: "main" });
    expect(f.git.tracked).toEqual(tracked);
    // built and installed folders are not walked
    expect(f.files).toContain("app/page.tsx");
    expect(f.files.some((p: string) => p.startsWith("node_modules/") || p.startsWith("dist/"))).toBe(false);
    expect(f.truncated).toBe(false);
    expect(f.pkg).toMatchObject({ name: "polar-parts", homepage: "https://polarparts.example", engines: { node: ">=20" }, scripts: { test: "vitest run" } });
    expect(f.pkg.deps).toMatchObject({ next: "15.0.0", vitest: "^3.0.0" });
    expect(f.lockfile).toBe("npm");
    expect(f.tests).toMatchObject({ script: "vitest run", playwright: true });
    expect(f.tests.files).toBeGreaterThanOrEqual(2);
    expect(f.ci.workflows).toEqual([{ file: ".github/workflows/ci.yml", onPullRequest: true, runsTests: true, deploys: false }]);
    expect(f.env).toMatchObject({ tracked: [], example: true, ignored: true });
    expect(f.env.files.sort()).toEqual([".env", ".env.example"]);
    expect(f.secrets).toEqual([]);
    expect(f.payments).toEqual({ provider: "stripe", testKeyInProduction: [], secretInClient: [] });
    expect(f.hosting).toMatchObject({ provider: "vercel", previews: true });
    expect(f.readme).toEqual({ exists: true, chars: expect.any(Number), boilerplate: false });
    expect(f.monitoring).toMatchObject({ genclass: false, sentry: true });
    expect(f.seo).toMatchObject({ robots: true, sitemap: true, llms: true, ogImage: true });
    expect(f.site).toEqual({ url: "https://polarparts.example", from: expect.any(String) });
    // plain data: it survives JSON
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
  });

  it("GitHub remotes in every form, and remotes that are not GitHub", () => {
    const dir = tempDir();
    write(dir, { "package.json": "{}" });
    const name = (remote: string | null) => collectRepoFacts(dir, { runGit: git({ remote }) }).git.github;
    for (const r of ["https://github.com/acme/shop.git", "https://github.com/acme/shop", "git@github.com:acme/shop.git", "git@github.com:acme/shop", "ssh://git@github.com/acme/shop.git"]) expect(name(r), r).toBe("acme/shop");
    for (const r of ["https://gitlab.com/acme/shop.git", "git@bitbucket.org:acme/shop.git", "", null]) expect(name(r), String(r)).toBeNull();
  });

  it("secrets in tracked files are found by kind, file and line, and their values appear nowhere", () => {
    const dir = tempDir();
    write(dir, {
      "package.json": JSON.stringify({ name: "leaky", dependencies: { stripe: "1.0.0" } }),
      ".env": `# real\nSTRIPE_SECRET_KEY=${LIVE}\nSESSION_SECRET=${SESSION}\nPUBLIC_NAME=shop\nEMPTY_TOKEN=\n`,
      ".env.production": `NEXT_PUBLIC_STRIPE_KEY=${PK_TEST}\n`,
      ".env.example": `STRIPE_SECRET_KEY=sk_live_xxx\nOPENAI_API_KEY=your_key_here\nSESSION_SECRET=changeme\n`,
      "src/pay.ts": `const a = 1;\nconst stripe = new Stripe("${TEST}");\n`,
      "src/ai.ts": `export const key = "${OPENAI}";\nexport const other = "${ANTHROPIC}";\n`,
      "deploy/aws.sh": `export AWS_ACCESS_KEY_ID=${AWS}\n`,
      "scripts/release.mjs": `const t = "${GH}";\n\n\nconst s = "${SLACK}";\n`,
      "keys/id_rsa": `-----BEGIN OPENSSH PRIVATE KEY-----\n${scramble(64, 21)}\n-----END OPENSSH PRIVATE KEY-----\n`,
      "untracked/secret.ts": `const k = "${LIVE}";\n`,
      "package-lock.json": `{"integrity": "${LIVE}"}`,
    });
    const tracked = ["package.json", ".env", ".env.production", ".env.example", "src/pay.ts", "src/ai.ts", "deploy/aws.sh", "scripts/release.mjs", "keys/id_rsa", "package-lock.json"];
    const f = collectRepoFacts(dir, { runGit: git({ tracked }) });
    const found = f.secrets.map((s: { file: string; line: number; kind: string }) => `${s.kind} ${s.file}:${s.line}`).sort();
    expect(found).toEqual(
      [
        "stripe-secret-live .env:2",
        "generic-secret .env:3",
        "stripe-secret-test src/pay.ts:2",
        "openai-key src/ai.ts:1",
        "anthropic-key src/ai.ts:2",
        "aws-access-key deploy/aws.sh:1",
        "github-token scripts/release.mjs:1",
        "slack-token scripts/release.mjs:4",
        "private-key keys/id_rsa:1",
      ].sort(),
    );
    // only tracked files count, a lock file is skipped, and the example file's placeholders are not secrets
    expect(found.some((s: string) => /untracked|package-lock|\.env\.example/.test(s))).toBe(false);
    // no value of any secret is anywhere in the facts
    const all = JSON.stringify(f);
    for (const v of [LIVE, TEST, PK_TEST, OPENAI, ANTHROPIC, AWS, GH, SLACK, SESSION]) expect(all.includes(v), v.slice(0, 12)).toBe(false);
    // a real .env file in git, a test key in a production env file, a secret key in code that ships to the browser
    // (an env file that only sets names a framework ships to the browser, such as NEXT_PUBLIC_*, holds nothing private)
    expect(f.env.tracked).toEqual([".env"]);
    expect(f.env.example).toBe(true);
    expect(f.payments.testKeyInProduction).toEqual([".env.production"]);
    expect(f.payments.secretInClient).toEqual(["src/pay.ts"]);
    // redactSecrets takes a secret's value out of any text
    const red = redactSecrets(`key ${LIVE} and ${GH} here`);
    expect(red.includes(LIVE) || red.includes(GH)).toBe(false);
    // a value that repeats a few characters, or says it is a placeholder, is not reported
    const dull = tempDir();
    write(dull, { "a.ts": `const a = "sk_live_${"51Nx".repeat(8)}";\nconst b = "ghp_${"x".repeat(36)}";\nconst c = "sk_live_your_key_here_0000000000";\n` });
    expect(collectRepoFacts(dull, { runGit: noGit }).secrets).toEqual([]);
    expect(redactSecrets("nothing to hide")).toBe("nothing to hide");
  });

  it("a folder that is no git repository scans its files, and a folder with nothing in it gives empty facts", () => {
    const dir = tempDir();
    write(dir, { "index.html": "<title>x</title>", "CNAME": "www.polarparts.example\n", "notes.txt": `token ${GH}\n`, "README.md": "# React + Vite\n\nThis template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.\n" });
    const f = collectRepoFacts(dir, { runGit: noGit });
    expect(f.git).toEqual({ repo: false, tracked: null, remote: null, github: null, branch: null });
    expect(f.pkg).toBeNull();
    expect(f.name).toBe(dir.split("/").pop());
    expect(f.secrets).toEqual([{ file: "notes.txt", line: 1, kind: "github-token" }]);
    expect(f.readme).toMatchObject({ exists: true, boilerplate: true });
    expect(f.site).toEqual({ url: "https://www.polarparts.example", from: expect.any(String) });
    expect(f.tests).toMatchObject({ files: 0, script: null, playwright: false });
    expect(f.lockfile).toBeNull();
    const empty = collectRepoFacts(tempDir(), { runGit: noGit });
    expect(empty).toMatchObject({ files: [], pkg: null, secrets: [], readme: { exists: false }, hosting: { provider: null }, payments: { provider: null } });
    // a folder that does not exist, and no arguments at all, do not throw
    expect(collectRepoFacts("/nonexistent/genclass/folder", { runGit: noGit })).toMatchObject({ files: [], pkg: null });
    expect(emptyRepoFacts("/x/y")).toMatchObject({ dir: "/x/y", name: "y", files: [], secrets: [] });
  });

  it("hosting, previews, other CI, the default test script and the file cap", () => {
    const host = (files: Record<string, string>) => {
      const d = tempDir();
      write(d, { "package.json": JSON.stringify({ name: "x", scripts: { test: 'echo "Error: no test specified" && exit 1' } }), ...files });
      return collectRepoFacts(d, { runGit: noGit });
    };
    expect(host({ "netlify.toml": "[build]\n" }).hosting).toMatchObject({ provider: "netlify", previews: true });
    expect(host({ "wrangler.toml": 'name = "x"\n' }).hosting).toMatchObject({ provider: "cloudflare", previews: null });
    expect(host({ "wrangler.toml": 'name = "x"\n\n[env.staging]\nname = "x-staging"\n' }).hosting).toMatchObject({ provider: "cloudflare", previews: true });
    expect(host({ "fly.toml": 'app = "x"\n' }).hosting.provider).toBe("fly");
    expect(host({ Dockerfile: "FROM node:22\n" }).hosting.provider).toBe("docker");
    expect(host({}).hosting).toEqual({ provider: null, previews: null, staging: null });
    // npm's placeholder test script is no test script; other CI systems are named
    const f = host({ ".gitlab-ci.yml": "test:\n  script: npm test\n", ".circleci/config.yml": "version: 2\n", "pnpm-lock.yaml": "lockfileVersion: 9\n" });
    expect(f.tests.script).toBeNull();
    expect(f.ci.other.sort()).toEqual([".circleci/config.yml", ".gitlab-ci.yml"]);
    expect(f.lockfile).toBe("pnpm");
    // a workflow that only deploys on push
    const d = host({ ".github/workflows/deploy.yml": "on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    steps:\n      - run: npx wrangler deploy\n" });
    expect(d.ci.workflows).toEqual([{ file: ".github/workflows/deploy.yml", onPullRequest: false, runsTests: false, deploys: true }]);
    // the cap
    const many = tempDir();
    write(many, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/f${i}.ts`, "x"])));
    const capped = collectRepoFacts(many, { runGit: noGit, maxFiles: 10 });
    expect(capped.files).toHaveLength(10);
    expect(capped.truncated).toBe(true);
  });

  it("GenClass in the app is seen from the dependency or from the marker init leaves", () => {
    const withDep = tempDir();
    write(withDep, { "package.json": JSON.stringify({ dependencies: { "@genclass/runtime": "0.3.0-beta.6" } }) });
    expect(collectRepoFacts(withDep, { runGit: noGit }).monitoring.genclass).toBe(true);
    const withTag = tempDir();
    write(withTag, { "index.html": '<head><script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.6" defer></script></head>' });
    expect(collectRepoFacts(withTag, { runGit: noGit }).monitoring.genclass).toBe(true);
    const other = tempDir();
    write(other, { "package.json": JSON.stringify({ dependencies: { "posthog-js": "1.0.0", "@datadog/browser-rum": "5.0.0" } }) });
    const m = collectRepoFacts(other, { runGit: noGit }).monitoring;
    expect(m).toMatchObject({ genclass: false, sentry: false });
    expect(m.other.sort()).toEqual(["datadog", "posthog"]);
  });
});
