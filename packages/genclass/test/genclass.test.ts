// genclass, the short command (packages/genclass): `npx genclass <command>` runs `genclass-runtime <command>` from
// @genclass/runtime at the same version. Checked here: package.json (genclass at the runtime's version, one bin, the
// files npm packs, @genclass/runtime its only dependency, in a range the workspace runtime satisfies, so npm links
// packages/runtime instead of fetching a copy from the registry); cli.mjs runs the runtime's CLI with the same
// arguments, output and exit code; release.yml, read as text (as packages/playwright/test/release.test.ts reads
// release-packages.yml), publishes genclass once npm has the runtime, only for a stable version and only when the
// repository variable GENCLASS_CLI is on, with exactly that runtime version as its dependency, to npm's latest; and no
// README or other document outside packages/genclass/ prints `npx genclass` as a command, nor this package's own README
// while it says genclass is not on npm, because until genclass is on npm that command runs whatever npm serves under
// the name. The release commit of the first version takes that note out and gives the README the short command; the
// change that starts printing it elsewhere, after the first publish, changes the check for the other documents.
// ci.yml's runtime job runs this file.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const repo = join(pkgDir, "..", "..");
const read = (f: string) => readFileSync(join(repo, f), "utf8");
const json = (f: string) => JSON.parse(read(f)) as Record<string, any>;
const pkg = json("packages/genclass/package.json");
const runtime = json("packages/runtime/package.json");
const lock = json("package-lock.json") as { packages: Record<string, Record<string, unknown>> };

/** One version and nothing else: 0.3.0-beta.5, =0.3.0, v0.3.0 (npm installs exactly that version). */
const EXACT_VERSION = /^\s*(?:=|v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\s*$/;

/** A version's major.minor.patch and its prerelease identifiers (numbers where they are numeric). */
function parseVersion(v: string): { core: number[]; pre: (number | string)[] } {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) throw new Error(`not a version: ${v}`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) };
}

/** Semver precedence: below 0 when a comes first, 0 when equal, above 0 when b comes first. */
function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  // a release comes after its prereleases
  if (x.pre.length === 0 || y.pre.length === 0) return (x.pre.length === 0 ? 1 : 0) - (y.pre.length === 0 ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Whether npm installs `version` for `range` of the form `>=<min>`, the one form this package uses: at least `min`,
 * and a prerelease only when `min` is a prerelease of the same major.minor.patch (npm's rule for prereleases).
 */
function admits(range: string, version: string): boolean {
  const m = /^>=\s*(\S+)$/.exec(range.trim());
  if (!m) throw new Error(`not a >= range: ${range}`);
  const min = parseVersion(m[1]);
  const v = parseVersion(version);
  if (compareVersions(version, m[1]) < 0) return false;
  return v.pre.length === 0 || (min.pre.length > 0 && v.core.every((n, i) => n === min.core[i]));
}

describe("genclass: package.json", () => {
  it("is genclass at the version of packages/runtime/package.json, public, an ES module with one bin, genclass → ./cli.mjs", () => {
    expect(pkg.name).toBe("genclass");
    expect(pkg.version, "packages/genclass/package.json follows packages/runtime/package.json: give it the same version").toBe(runtime.version);
    expect(pkg.private).toBeUndefined();
    expect(pkg.type).toBe("module");
    expect(pkg.bin).toEqual({ genclass: "./cli.mjs" });
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.engines).toEqual(runtime.engines);
    // npm rejects a provenance statement whose repository is not the package's repository.url
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/genclass-dev/GenClass.git", directory: "packages/genclass" });
    // no lifecycle scripts: installing genclass runs nothing, and release.yml packs it with --ignore-scripts
    expect(pkg.scripts).toBeUndefined();
  });

  it("npm packs cli.mjs, README.md and LICENSE (and package.json), and each one is here", () => {
    expect(pkg.files).toEqual(["cli.mjs", "README.md", "LICENSE"]);
    for (const f of pkg.files as string[]) expect(existsSync(join(pkgDir, f)), f).toBe(true);
    expect(existsSync(join(pkgDir, ".npmignore"))).toBe(false);
  });

  it("@genclass/runtime is its only dependency, in a >= range that admits the workspace runtime, not an exact version", () => {
    expect(pkg.dependencies).toEqual({ "@genclass/runtime": expect.any(String) });
    for (const k of ["devDependencies", "peerDependencies", "peerDependenciesMeta", "optionalDependencies", "bundleDependencies", "bundledDependencies"]) expect(pkg[k], k).toBeUndefined();
    const range = pkg.dependencies["@genclass/runtime"] as string;
    // an exact version stops matching packages/runtime at the runtime's next version, and npm then installs that
    // version from the registry (release.yml pins the exact version in the published package only)
    expect(range).not.toMatch(EXACT_VERSION);
    expect(admits(range, runtime.version), `${range} must admit packages/runtime's ${runtime.version}: make it >=${runtime.version}`).toBe(true);
  });

  it("the range check follows npm: a prerelease only within the same major.minor.patch, any later release", () => {
    expect(admits(">=0.3.0-beta.5", "0.3.0-beta.5")).toBe(true);
    expect(admits(">=0.3.0-beta.5", "0.3.0-beta.10")).toBe(true);
    expect(admits(">=0.3.0-beta.5", "0.3.0")).toBe(true);
    expect(admits(">=0.3.0-beta.5", "0.3.1")).toBe(true);
    expect(admits(">=0.3.0-beta.5", "1.0.0")).toBe(true);
    expect(admits(">=0.3.0-beta.5", "0.3.0-beta.4")).toBe(false);
    expect(admits(">=0.3.0-beta.5", "0.3.0-alpha.9")).toBe(false);
    expect(admits(">=0.3.0-beta.5", "0.2.3")).toBe(false);
    expect(admits(">=0.3.0-beta.5", "0.4.0-beta.0")).toBe(false);
    expect(admits(">=0.3.0", "0.3.1-beta.0")).toBe(false);
    expect(() => admits("^0.3.0", "0.3.0")).toThrow();
  });

  it("the root package-lock.json links genclass and its runtime to the workspace, with no copy of its own", () => {
    expect(lock.packages["node_modules/genclass"]).toEqual({ resolved: "packages/genclass", link: true });
    const entry = lock.packages["packages/genclass"];
    expect(entry.version).toBe(pkg.version);
    expect(entry.dependencies).toEqual(pkg.dependencies);
    expect(entry.bin).toEqual({ genclass: "cli.mjs" });
    expect(entry.devDependencies).toBeUndefined();
    expect(Object.keys(lock.packages).filter((k) => k.startsWith("packages/genclass/"))).toEqual([]);
    expect(lock.packages["node_modules/@genclass/runtime"]).toEqual({ resolved: "packages/runtime", link: true });
  });
});

describe("genclass: cli.mjs runs the runtime's CLI", () => {
  const cli = join(pkgDir, "cli.mjs");
  const runtimeCli = join(repo, "packages", "runtime", runtime.bin["genclass-runtime"]);
  const run = (file: string, args: string[]) => spawnSync(process.execPath, [file, ...args], { cwd: pkgDir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

  it("resolves the workspace's @genclass/runtime, whose package.json names the genclass-runtime bin cli.mjs runs", () => {
    const resolved = createRequire(cli).resolve("@genclass/runtime/package.json");
    expect(realpathSync(resolved)).toBe(realpathSync(join(repo, "packages", "runtime", "package.json")));
    expect(existsSync(runtimeCli)).toBe(true);
    expect(readFileSync(cli, "utf8")).toContain('bin["genclass-runtime"]');
  });

  it("`genclass --help` prints what `genclass-runtime --help` prints, byte for byte, and exits 0", () => {
    const short = run(cli, ["--help"]);
    const long = run(runtimeCli, ["--help"]);
    expect(short.status).toBe(0);
    expect(short.stdout).toMatch(/^Usage:\n {2}genclass-runtime init /);
    expect(short.stdout).toBe(long.stdout);
    expect(short.stderr).toBe(long.stderr);
  });

  it("passes the arguments and the exit code through: an unknown command exits 2 with the runtime's message", () => {
    const short = run(cli, ["no-such-command"]);
    const long = run(runtimeCli, ["no-such-command"]);
    expect(short.status).toBe(2);
    expect(short.stderr).toMatch(/^genclass-runtime: unknown command no-such-command\n/);
    expect({ status: short.status, stdout: short.stdout, stderr: short.stderr }).toEqual({ status: long.status, stdout: long.stdout, stderr: long.stderr });
  });
});

/**
 * The block that starts at the line `<indent><key>:`: that line and the lines after it that are blank or indented
 * deeper, without trailing blank lines (as in packages/playwright/test/release.test.ts).
 */
function block(text: string, key: string, indent: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `${indent}${key}:` || l.startsWith(`${indent}${key}: `));
  if (start < 0) throw new Error(`no line "${indent}${key}:"`);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || lines[end].startsWith(`${indent} `))) end++;
  return lines.slice(start, end).join("\n").replace(/\n+$/, "");
}

/** The step of a job whose `- name:` is `name`: that line and the step's own lines after it (as in release-notes.test.ts). */
function step(jobText: string, name: string): string {
  const lines = jobText.split("\n");
  const start = lines.indexOf(`      - name: ${name}`);
  if (start < 0) throw new Error(`no step "${name}"`);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || lines[end].startsWith("        "))) end++;
  return lines.slice(start, end).join("\n").replace(/\n+$/, "");
}

/** The lines of a text that run `npm publish`, trimmed (comments and messages that mention it do not count). */
const publishes = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(?:run: )?npm publish /.test(l));

describe("release.yml: genclass after the runtime, stable versions only, when GENCLASS_CLI is on", () => {
  const yml = read(".github/workflows/release.yml");
  const jobs = block(yml, "jobs", "");
  const job = (id: string) => block(jobs, id, "  ");
  const STABLE_AND_ON = "vars.GENCLASS_CLI == 'on' && !contains(github.ref_name, '-')";

  it("the genclass job runs once the runtime's publish job has published, only on a v* tag push of a version without a -, and only when GENCLASS_CLI is on", () => {
    const genclass = job("genclass");
    expect(genclass).toContain("\n    needs: publish\n");
    // !cancelled() instead of the implicit success(): a later step of the publish job (its signature check) can fail
    // after npm has the runtime, and a re-run of that job stops at its npm publish
    expect(genclass.split("\n").filter((l) => /^ {4}if:/.test(l))).toEqual([
      `    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && !cancelled() && needs.publish.outputs.published == 'true' && ${STABLE_AND_ON}`,
    ]);
    expect(genclass.split("\n").filter((l) => /^ {4}environment:/.test(l))).toEqual(["    environment: npm-publish"]);
    expect(genclass).toMatch(/^ {6}id-token: write /m);
    expect(genclass).toContain("persist-credentials: false");
  });

  it("its pack step refuses a prerelease and another genclass version, then sets the dependency to exactly the tag's version before npm pack and checks the tarball", () => {
    const pack = step(job("genclass"), "Pack genclass with exactly this runtime version as its dependency");
    const order = [
      'VERSION="${GITHUB_REF_NAME#v}"',
      '*-*) echo "::error::genclass is published for stable versions only, not $VERSION"; exit 1 ;;',
      `test "$(node -p "require('./packages/genclass/package.json').version")" = "$VERSION"`,
      'npm pkg set "dependencies.@genclass/runtime=$VERSION" -w genclass',
      "npm pack -w genclass --ignore-scripts --silent",
      'tar -xOzf "$FILE" package/package.json',
      'deps !== JSON.stringify({ "@genclass/runtime": version })',
      'test "$(tr \'\\n\' \' \' < "$FILE.files.txt")" = "package/LICENSE package/README.md package/cli.mjs package/package.json "',
    ];
    let at = -1;
    for (const s of order) {
      const i = pack.indexOf(s);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
  });

  it("it publishes that tarball once, with provenance, to latest, after checking npm has genclass (its first version is the owner's)", () => {
    const genclass = job("genclass");
    expect(publishes(genclass)).toEqual(['run: npm publish "$FILE" --provenance --access public --tag latest']);
    expect(genclass.indexOf("      - name: npm has genclass\n")).toBeGreaterThan(genclass.indexOf("      - name: Pack genclass"));
    expect(genclass.indexOf("      - name: Publish with provenance, to latest\n")).toBeGreaterThan(genclass.indexOf("      - name: npm has genclass\n"));
    expect(genclass).toContain("name: genclass-tarball");
    const verify = step(genclass, "Verify the registry signature and provenance, and the command");
    expect(verify).toContain('npm install --no-audit --no-fund --ignore-scripts "genclass@$VERSION"');
    expect(verify).toContain(`test "$(node -p "require('@genclass/runtime/package.json').version")" = "$VERSION"`);
    expect(verify).toContain("npm audit signatures");
  });

  it("the runtime's publish job says published=true on the line after its npm publish, as the job's published output", () => {
    const publish = job("publish");
    expect(block(publish, "outputs", "    ").split("\n").filter((l) => !l.trim().startsWith("#"))).toEqual(["    outputs:", "      published: ${{ steps.publish.outputs.published }}"]);
    const run = step(publish, "Publish with provenance").split("\n");
    expect(run[1]).toBe("        id: publish");
    const at = run.findIndex((l) => l.trim().startsWith("npm publish "));
    expect(at).toBeGreaterThan(0);
    expect(run[at + 1]).toBe('          echo "published=true" >> "$GITHUB_OUTPUT"');
    expect(run.filter((l) => l.includes("published="))).toHaveLength(1);
  });

  it("the runtime's publish job publishes only the runtime, and checks genclass's version and README before it when genclass follows", () => {
    const publish = job("publish");
    expect(publishes(publish)).toEqual(['npm publish "${{ steps.pack.outputs.file }}" --provenance --access public --tag "$DIST_TAG"']);
    const tag = step(publish, "The tag names the package version");
    expect(tag).toContain(`\n          GENCLASS: \${{ ${STABLE_AND_ON} }}\n`);
    expect(tag).toContain('if [ "$GENCLASS" = true ]; then');
    expect(tag).toContain('test "$GC" = "$PKG"');
    expect(tag).toContain('grep -qi "not on npm" packages/genclass/README.md');
    // only the quoted note at the top of genclass's README says so, so taking that note out clears the check
    const says = read("packages/genclass/README.md").split("\n").filter((l) => /not on npm/i.test(l));
    for (const l of says) expect(l, "only the note at the top of packages/genclass/README.md says genclass is not on npm").toMatch(/^> /);
  });

  it("no other job publishes anything, and the workflow's token only reads", () => {
    expect(publishes(yml)).toHaveLength(2);
    expect(block(yml, "permissions", "")).toBe("permissions:\n  contents: read");
    expect(publishes(job("github-release"))).toEqual([]);
  });
});

/**
 * `npx genclass` and the other ways to run or install the package named genclass, as a command: npx, bunx, pnpx,
 * pnpm dlx, yarn dlx, npm exec, and npm, pnpm, yarn or bun install or add, with any flags before the name. A longer
 * name (genclass-runtime, genclass-playwright-report) and a scoped one (@genclass/runtime) do not count.
 */
const COMMAND = /(?:\bnpx|\bbunx|\bpnpx|\bpnpm dlx|\byarn dlx|\bnpm exec|\bnpm (?:i|install|add)|\bpnpm (?:i|install|add)|\byarn add|\bbun (?:i|install|add))(?:\s+-{1,2}[\w-]+)*\s+genclass(?![-\w])/;

describe("no document outside packages/genclass/ prints npx genclass as a command", () => {
  it("the pattern: npx genclass and its variants, not genclass-runtime, genclass-playwright-report or @genclass/runtime", () => {
    for (const s of ["npx genclass init", "`npx genclass`", "npx genclass", "npx -y genclass scan <url>", "npx genclass@0.3.0 init", "bunx genclass init", "pnpm dlx genclass init", "npm i -g genclass", "npm install genclass"]) expect(COMMAND.test(s), s).toBe(true);
    for (const s of ["npx genclass-runtime init", "npx genclass-playwright-report", "npx -p @genclass/playwright genclass-playwright-report", "npx @genclass/runtime@beta init", "npm i @genclass/runtime", "npx genclassify", "the genclass package"]) expect(COMMAND.test(s), s).toBe(false);
  });

  it("README files, docs/ and every other Markdown or text file in the repository, packages/genclass/ excepted", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
    const docs = tracked.filter(
      (f) =>
        !f.startsWith("packages/genclass/") &&
        !/\.(?:png|gif|jpe?g|webp|webm|mp4|ico|pdf|zip|gz|tgz|woff2?|onnx|bin)$/i.test(f) &&
        (/(?:^|\/)README[^/]*$/i.test(f) || f.startsWith("docs/") || /\.(?:md|mdx|txt)$/i.test(f)),
    );
    expect(docs).toEqual(expect.arrayContaining(["README.md", "llms.txt", "CONTRIBUTING.md", "packages/runtime/README.md", "docs/runtime/API.md"]));
    const hits: string[] = [];
    for (const f of docs) {
      let text: string;
      try {
        text = readFileSync(join(repo, f), "utf8");
      } catch {
        continue; // deleted in the working tree
      }
      if (text.includes("\0")) continue;
      text.split("\n").forEach((line, i) => {
        if (COMMAND.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits, "genclass is not on npm yet: print npx @genclass/runtime@beta <command> instead (packages/genclass/README.md)").toEqual([]);
  });

  it("packages/genclass/README.md gives no npx genclass command while it says genclass is not on npm, and the short command once that note is gone", () => {
    const readme = read("packages/genclass/README.md");
    const commands = readme.split("\n").filter((l) => COMMAND.test(l));
    if (/not on npm/i.test(readme)) {
      expect(commands, "genclass is not on npm yet: give the README's commands as npx @genclass/runtime@beta <command>").toEqual([]);
      expect(readme).toContain("\nnpx @genclass/runtime@beta init ");
    } else {
      // the release commit of the first version: the README npm will show gives the short command
      expect(commands.length, "the note is gone, so this README is a release's: give its commands as npx genclass <command>").toBeGreaterThan(0);
    }
  });
});
