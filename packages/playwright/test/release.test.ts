// The release workflow of the four framework packages, .github/workflows/release-packages.yml, read as text (no YAML
// parser, the way packages/mcp/test/manifests.test.ts reads its files): one tag pattern per package that starts no
// other release workflow, a pull-request run that goes as far as `npm publish --dry-run`, and a publish job that runs
// only on a tag push, is the only job with the OIDC token and the npm-publish environment, and publishes the build
// job's tarball without checking out or installing anything. Each package builds on the Node version of its own
// workflow. Each package.json is one the workflow can publish: `@genclass/<dir>`, public, dist/ in its files, the
// repository npm's provenance check expects, and a `prepack` that builds, so a tarball packed by hand has dist/ too.
// playwright-reporter.yml and the release workflow's own pull-request run (its playwright job) run this file.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { here } from "./helpers.js";

const repo = join(here, "..", "..", "..");
const read = (f: string) => readFileSync(join(repo, f), "utf8");
const WORKFLOW = ".github/workflows/release-packages.yml";
const yml = read(WORKFLOW);

/** Each package and the Node version its own workflow runs it on. */
const PACKAGES = [
  { package: "playwright", node: "22" },
  { package: "sv", node: "22" },
  { package: "nuxt", node: "24" },
  { package: "astro", node: "24" },
];
const OWN_WORKFLOW: Record<string, string> = { playwright: "playwright-reporter.yml", sv: "sv-addon.yml", nuxt: "integrations.yml", astro: "integrations.yml" };
const TAG_PUSH = "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')";

/**
 * The block that starts at the line `<indent><key>:`: that line and the lines after it that are blank or indented
 * deeper, without trailing blank lines.
 */
function block(text: string, key: string, indent: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `${indent}${key}:` || l.startsWith(`${indent}${key}: `));
  if (start < 0) throw new Error(`no line "${indent}${key}:"`);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || lines[end].startsWith(`${indent} `))) end++;
  return lines.slice(start, end).join("\n").replace(/\n+$/, "");
}

/** The keys directly under a block, one indent level (two spaces) deeper. */
const keys = (b: string, indent: string) => [...b.matchAll(new RegExp(`^${indent}  ([a-z_][a-z0-9_-]*):`, "gm"))].map((m) => m[1]);

/** The tags a workflow's push trigger names, from its `tags: [...]` line. */
const pushTags = (text: string) => JSON.parse(/^ {4}tags: (\[.*\])$/m.exec(block(block(text, "on", ""), "push", "  "))?.[1] ?? "null") as string[];

const escapeRegExp = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
/** GitHub's filter pattern as a RegExp (these patterns use only `*`: any characters but `/`). */
const glob = (pattern: string) => new RegExp("^" + pattern.split("*").map(escapeRegExp).join("[^/]*") + "$");

const on = block(yml, "on", "");
const jobs = block(yml, "jobs", "");
const job = (id: string) => block(jobs, id, "  ");

describe("release-packages.yml: what starts it", () => {
  it("a tag push per package (playwright-v*, sv-v*, nuxt-v*, astro-v*) and a pull request, nothing else", () => {
    expect(keys(on, "")).toEqual(["push", "pull_request"]);
    expect(keys(block(on, "push", "  "), "  ")).toEqual(["tags"]);
    expect(pushTags(yml)).toEqual(PACKAGES.map((p) => `${p.package}-v*`));
  });

  it("each package's tags start this workflow, and neither release.yml (v*) nor release-mcp.yml (mcp-v*)", () => {
    const own = pushTags(yml).map(glob);
    const others = [...pushTags(read(".github/workflows/release.yml")), ...pushTags(read(".github/workflows/release-mcp.yml"))];
    expect(others).toEqual(["v*", "mcp-v*"]);
    for (const { package: p } of PACKAGES) {
      for (const tag of [`${p}-v0.1.0`, `${p}-v0.2.0-beta.1`]) {
        expect(own.filter((g) => g.test(tag)), tag).toHaveLength(1);
        for (const other of others) expect(glob(other).test(tag), `${tag} would start the workflow for ${other}`).toBe(false);
        // the packages job takes the package from the tag the way bash's ${GITHUB_REF_NAME%%-v*} does
        expect(tag.slice(0, tag.indexOf("-v")), tag).toBe(p);
      }
    }
  });

  it("a pull request that changes this file or one of the four package.json files runs it; never pull_request_target", () => {
    const pr = block(on, "pull_request", "  ");
    expect(keys(pr, "  ")).toEqual(["paths"]);
    expect([...pr.matchAll(/^ {6}- "([^"]+)"$/gm)].map((m) => m[1])).toEqual([WORKFLOW, ...PACKAGES.map((p) => `packages/${p.package}/package.json`)]);
    expect(yml).not.toContain("pull_request_target");
    // a newer push cancels a pull request's older run; a tag's run is never cancelled
    expect(block(yml, "concurrency", "")).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });
});

describe("release-packages.yml: the jobs", () => {
  it("the workflow's token only reads; only the publish job has the OIDC token or an environment; no secrets", () => {
    expect(block(yml, "permissions", "")).toBe("permissions:\n  contents: read");
    expect(keys(jobs, "")).toEqual(expect.arrayContaining(["packages", "build", "publish", "verify"]));
    for (const id of keys(jobs, "").filter((j) => j !== "publish")) {
      expect(job(id), id).not.toContain("id-token");
      expect(job(id), id).not.toContain("environment:");
    }
    expect(yml).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it("the packages job: each package with its own workflow's Node version; a tag picks its package, a pull request all four", () => {
    const packages = job("packages");
    expect(JSON.parse(/^ {6}PACKAGES: '(.*)'$/m.exec(packages)?.[1] ?? "null")).toEqual(PACKAGES);
    expect(packages).toContain('push:refs/tags/*) PICK="${GITHUB_REF_NAME%%-v*}" ;;');
    expect(packages).toContain("pull_request:*) PICK=all ;;");
    expect(packages).not.toContain("\n    if:");
  });

  it("each package builds on the Node version of its own workflow", () => {
    for (const { package: p, node } of PACKAGES) {
      const versions = new Set([...read(`.github/workflows/${OWN_WORKFLOW[p]}`).matchAll(/node-version: (\d+)/g)].map((m) => m[1]));
      expect([...versions], `${OWN_WORKFLOW[p]} runs ${p}`).toEqual([node]);
    }
  });

  it("the build job runs on tags and pull requests: version, install, runtime build, typecheck, build, unit tests, pack, dry run", () => {
    const build = job("build");
    expect(build).not.toContain("\n    if:");
    expect(build).toContain("matrix: ${{ fromJSON(needs.packages.outputs.matrix) }}");
    expect(build).toContain("node-version: ${{ matrix.node }}");
    const steps = [
      "- name: The tag names the package version",
      'test "$TAG" = "$VERSION"',
      "npm ci --no-audit --no-fund",
      "npm run build -w @genclass/runtime",
      'npm run typecheck -w "@genclass/$PKG"',
      'npm run build -w "@genclass/$PKG"',
      'if [ "$PKG" = sv ]; then npx vitest run --project unit; else npx vitest run; fi',
      "npm pack --ignore-scripts --silent",
      "name: ${{ matrix.package }}-tarball",
      'npm publish "$FILE" --dry-run --access public --tag "$DIST_TAG"',
    ];
    let at = -1;
    for (const s of steps) {
      const i = build.indexOf(s);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
    for (const line of build.split("\n").filter((l) => l.includes("npm publish") && !l.trim().startsWith("#"))) expect(line).toContain("--dry-run");
    expect(build).not.toContain("--provenance");
    // the dry run is skipped only for a version npm already has (npm 11 refuses one over a published stable version)
    const from = build.indexOf("      - name: npm publish --dry-run\n");
    const next = build.indexOf("\n      - ", from + 1);
    const dryRun = build.slice(from, next < 0 ? undefined : next);
    expect(from, "the dry-run step").toBeGreaterThan(-1);
    expect(dryRun.split("\n").filter((l) => /^ {8}if:/.test(l))).toEqual(["        if: steps.version.outputs.on_npm == 'no'"]);
  });

  it("the publish job runs only on a tag push, in the npm-publish environment with the OIDC token, and publishes the build job's tarball with provenance", () => {
    const publish = job("publish");
    expect(publish).toContain(`\n    ${TAG_PUSH}\n`);
    expect(publish).toContain("\n    needs: [packages, build]\n");
    expect(publish).toContain("\n    environment: npm-publish\n");
    expect(publish).toMatch(/^ {6}id-token: write /m);
    expect(publish).toContain('echo "$SHA512  $FILE" | sha512sum -c -');
    expect(publish).toContain('test "$GITHUB_REF_NAME" = "$PKG-v$VERSION"');
    expect(publish).toContain('npm publish "$FILE" --provenance --access public --tag "$DIST_TAG"');
    // the job that holds the token runs no repository code: nothing is checked out, installed or run from it
    expect(publish).not.toContain("actions/checkout");
    expect(publish.replace("npm install -g npm@11", "")).not.toMatch(/npm (ci|install|run|exec)\b|npx /);
  });

  it("the verify job runs only after a publish on a tag push: it installs the published version and runs npm audit signatures", () => {
    const verify = job("verify");
    expect(verify).toContain(`\n    ${TAG_PUSH}\n`);
    expect(verify).toContain("\n    needs: [packages, publish]\n");
    expect(verify).toContain('npm install --no-audit --no-fund --ignore-scripts "$NAME@$VERSION"');
    expect(verify).toContain("npm audit signatures");
  });

  it("every job after build runs only on a tag push", () => {
    for (const id of keys(jobs, "").filter((j) => j !== "packages" && j !== "build")) expect(job(id), id).toContain(`\n    ${TAG_PUSH}\n`);
  });
});

describe("the four package.json files", () => {
  for (const { package: p } of PACKAGES) {
    it(`packages/${p}: @genclass/${p}, public, dist/ in its files, this repository, and npm pack builds it first`, () => {
      const pkg = JSON.parse(read(`packages/${p}/package.json`)) as Record<string, any>;
      expect(pkg.name).toBe(`@genclass/${p}`);
      expect(pkg.private).toBeUndefined();
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/);
      expect(pkg.publishConfig).toEqual({ access: "public" });
      expect(pkg.files).toContain("dist");
      // npm rejects a provenance statement whose repository is not the package's repository.url
      expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/genclass-dev/GenClass.git", directory: `packages/${p}` });
      expect([pkg.scripts.build, "npm run build"]).toContain(pkg.scripts.prepack);
      expect(pkg.scripts.prepublishOnly).toBeUndefined();
    });
  }
});
