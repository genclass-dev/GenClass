// The GitHub releases the release workflows create. The script that writes their notes,
// .github/scripts/changelog-section.mjs (one version's section of a CHANGELOG), runs here as the command the workflows
// run. The github-release job of release.yml, release-mcp.yml and release-packages.yml is read as text, the way
// packages/playwright/test/release.test.ts reads its workflow (no YAML parser); its steps, and the part of each
// workflow's tag check that runs the script, run in bash with a stub `gh`. The job runs only on a tag push, after the
// publish job, and is the only job that may write to the repository. A missing or unreleased section stops release.yml
// and release-packages.yml in the step that checks the tag, before anything is published; release-mcp.yml only warns
// there and its notes link to the CHANGELOG, because @genclass/mcp 0.1.0 (tag mcp-v0.1.0) has no section of its own.
// A prerelease is marked as one; release-packages.yml never makes a release the repository's latest one, release.yml
// and release-mcp.yml only for a stable tag on the default branch (Gemini CLI and `gh skill` install from the latest
// release). mcp.yml runs this file.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = join(__dirname, "..", "..", "..");
const read = (f: string) => readFileSync(join(repo, f), "utf8");
const SCRIPT = ".github/scripts/changelog-section.mjs";
const TAG_PUSH = "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')";
const dir = mkdtempSync(join(tmpdir(), "genclass-release-notes-"));

/** Runs the script from the repository root, as the workflows do. */
function run(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Writes a CHANGELOG into this test's directory; returns its path. */
function changelog(name: string, lines: string[]): string {
  const file = join(dir, name);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** The 0.2.2 section of the CHANGELOG below, as it is in the file. */
const SECTION = [
  '- **First.** See [AGENT.md](../../docs/runtime/AGENT.md) and [the options](<../../docs/runtime/API.md#options> "API").',
  "- [npm](https://www.npmjs.com/package/@genclass/mcp), [mail](mailto:hi@genclass.dev), [the top](#changelog) and `[code](kept.md)`.",
  "",
  "### Fixes",
  "",
  "- fixed",
  "",
  "```md",
  "## not a heading: in a fence, [kept](kept.md)",
  "```",
  "",
  "[readme]: ../../README.md",
  '[site]: https://genclass.dev "GenClass"',
  "[Note]: these words are prose, not a link",
];

const CHANGELOG = changelog("CHANGELOG.md", [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "- next",
  "",
  "## 0.2.20 (2026-11-06)",
  "",
  "- twenty",
  "",
  "## 0.2.2 (2026-11-05)",
  "",
  ...SECTION,
  "",
  "## 0.2.2-beta.1 (2026-11-01)",
  "",
  "- beta",
  "",
  "## [0.2.1] - 2026-10-27",
  "",
  "- bracketed",
  "",
  "## v0.2.0 (2026-10-25)",
  "",
  "- v-prefixed",
  "",
  "## 0.1.2",
  "",
  "## 0.1.1 (unreleased)",
  "",
  "- not out yet",
  "",
  "## 0.1.0 (2026-01-02)",
  "",
  "- the last one at this level",
  "",
  "# Before the rename",
  "",
  "- not part of 0.1.0",
]);

/** Where the CHANGELOG is at a release's tag (what the workflows pass as --url). */
const AT_TAG = "https://github.com/genclass-dev/GenClass/blob/mcp-v0.2.2/packages/mcp/CHANGELOG.md";
const BLOB = "https://github.com/genclass-dev/GenClass/blob/mcp-v0.2.2";

describe("changelog-section.mjs: one version's section of a CHANGELOG, the notes of its GitHub release", () => {
  it("prints the text under the version's heading, without the heading or the blank lines around it, up to the next heading of its level; ### subsections stay", () => {
    expect(run(CHANGELOG, "0.2.2")).toEqual({ code: 0, out: `${SECTION.join("\n")}\n`, err: "" });
    expect(run(CHANGELOG, "0.2.20").out).toBe("- twenty\n");
    // a heading of a higher level ends it too
    expect(run(CHANGELOG, "0.1.0").out).toBe("- the last one at this level\n");
  });

  it("matches the version exactly (0.2.2 is neither 0.2.20 nor 0.2.2-beta.1); [0.2.1] and v0.2.0 headings match, and so does an asked v0.2.0", () => {
    expect(run(CHANGELOG, "0.2.2-beta.1").out).toBe("- beta\n");
    expect(run(CHANGELOG, "0.2.1").out).toBe("- bracketed\n");
    expect(run(CHANGELOG, "0.2.0").out).toBe("- v-prefixed\n");
    expect(run(CHANGELOG, "v0.2.0").out).toBe("- v-prefixed\n");
    expect(run(CHANGELOG, "0.2").code).toBe(1);
  });

  it("exits 1 with nothing on stdout when the version has no heading, its heading says unreleased, or its section is empty", () => {
    const missing = run(CHANGELOG, "0.3.0");
    expect(missing.code).toBe(1);
    expect(missing.out).toBe("");
    expect(missing.err).toContain(`${CHANGELOG} has no heading for 0.3.0`);
    // the CHANGELOG has an Unreleased section: the message says what its heading needs
    expect(missing.err).toContain('its Unreleased section needs the version and a date in its heading: "## 0.3.0 (<date>)"');
    const unreleased = run(CHANGELOG, "0.1.1");
    expect(unreleased).toMatchObject({ code: 1, out: "" });
    expect(unreleased.err).toContain('the heading for 0.1.1 says unreleased ("0.1.1 (unreleased)")');
    const empty = run(CHANGELOG, "0.1.2");
    expect(empty).toMatchObject({ code: 1, out: "" });
    expect(empty.err).toContain("the section for 0.1.2 is empty");
    const plain = changelog("plain.md", ["# Changelog", "", "## 0.1.0 (2026-01-02)", "", "- one"]);
    expect(run(plain, "0.2.0").err).toBe(`${plain} has no heading for 0.2.0\n`);
  });

  it("--url makes relative links absolute against the CHANGELOG's address at the tag; absolute links, code and prose stay", () => {
    const r = run(CHANGELOG, "0.2.2", "--url", AT_TAG);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        `- **First.** See [AGENT.md](${BLOB}/docs/runtime/AGENT.md) and [the options](<${BLOB}/docs/runtime/API.md#options> "API").`,
        `- [npm](https://www.npmjs.com/package/@genclass/mcp), [mail](mailto:hi@genclass.dev), [the top](${AT_TAG}#changelog) and \`[code](kept.md)\`.`,
        ...SECTION.slice(2, 11),
        `[readme]: ${BLOB}/README.md`,
        '[site]: https://genclass.dev "GenClass"',
        "[Note]: these words are prose, not a link",
      ].join("\n") + "\n",
    );
  });

  it("--or-link prints one line that links to the CHANGELOG and exits 0 when there is no section to print; it needs --url", () => {
    for (const version of ["0.3.0", "0.1.1", "0.1.2"]) {
      const r = run(CHANGELOG, version, "--or-link", "--url", AT_TAG);
      expect(r.code, version).toBe(0);
      expect(r.out, version).toBe(`See [${CHANGELOG}](${AT_TAG}).\n`);
      expect(r.err, version).toContain("printed a link to the CHANGELOG instead");
    }
    expect(run(CHANGELOG, "0.2.20", "--or-link", "--url", AT_TAG).out).toBe("- twenty\n");
    expect(run(CHANGELOG, "0.3.0", "--or-link").code).toBe(2);
  });

  it("cuts a section longer than GitHub takes for a release (125,000 characters) at a line, and its last line links to the rest", () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `- line ${i}: ${"x".repeat(50)}`);
    const big = changelog("big.md", ["# Changelog", "", "## 1.0.0 (2026-11-07)", "", ...lines, "", "## 0.9.0 (2026-11-01)", "", "- older"]);
    expect(lines.join("\n").length).toBeGreaterThan(125000);
    const r = run(big, "1.0.0", "--url", AT_TAG);
    expect(r.code).toBe(0);
    expect(r.out.length).toBeLessThanOrEqual(125000);
    const out = r.out.split("\n");
    expect(out.slice(-3)).toEqual(["", `The rest of this section is in [${big}](${AT_TAG}): GitHub takes at most 125,000 characters of release notes.`, ""]);
    const kept = out.slice(0, -3);
    expect(kept).toEqual(lines.slice(0, kept.length));
    expect(kept.length).toBeGreaterThan(1900);
    expect(r.err).toContain("cut at a line");
    // without --url the last line names the file
    expect(run(big, "1.0.0").out.trimEnd().endsWith(`in ${big}: GitHub takes at most 125,000 characters of release notes.`)).toBe(true);
  });

  it("usage errors exit 2: missing or extra arguments, an unknown flag, a --url that is not one, a file it cannot read", () => {
    for (const args of [[], [CHANGELOG], [CHANGELOG, "0.2.2", "extra"], [CHANGELOG, "0.2.2", "--nope"], [CHANGELOG, "0.2.2", "--url", "not a url"], [join(dir, "missing.md"), "0.2.2"]]) {
      const r = run(...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.out, args.join(" ")).toBe("");
    }
  });
});

describe("the CHANGELOGs of what the release workflows have published", () => {
  it("every version release.yml has published (v0.2.0 to v0.3.0-beta.5) has its own section in packages/runtime/CHANGELOG.md", () => {
    for (const version of ["0.2.0", "0.2.1", "0.2.2", "0.2.3", "0.3.0-beta.0", "0.3.0-beta.1", "0.3.0-beta.2", "0.3.0-beta.3", "0.3.0-beta.4", "0.3.0-beta.5"]) {
      const r = run("packages/runtime/CHANGELOG.md", version);
      expect(r.code, `${version}: ${r.err}`).toBe(0);
      expect(r.out.trim(), version).not.toBe("");
      expect(r.out, version).not.toMatch(/^#{1,2} /m);
    }
  });

  it("@genclass/mcp 0.2.0 to 0.2.2 have their own sections in packages/mcp/CHANGELOG.md", () => {
    for (const version of ["0.2.0", "0.2.1", "0.2.2"]) {
      const r = run("packages/mcp/CHANGELOG.md", version);
      expect(r.code, `${version}: ${r.err}`).toBe(0);
      expect(r.out, version).not.toMatch(/^#{1,2} /m);
    }
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

/** A job of a workflow. */
const job = (yml: string, id: string) => block(block(yml, "jobs", ""), id, "  ");

/** The step of a job whose `- name:` is `name`: that line and the step's own lines after it (blank or indented deeper). */
function step(jobText: string, name: string): string {
  const lines = jobText.split("\n");
  const start = lines.indexOf(`      - name: ${name}`);
  if (start < 0) throw new Error(`no step "${name}"`);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || lines[end].startsWith("        "))) end++;
  return lines.slice(start, end).join("\n").replace(/\n+$/, "");
}

/** A step's `run: |` script, without its indentation. */
function script(stepText: string): string {
  const lines = stepText.split("\n");
  const at = lines.indexOf("        run: |");
  if (at < 0) throw new Error("no run: | block");
  let end = at + 1;
  while (end < lines.length && (lines[end].trim() === "" || lines[end].startsWith("          "))) end++;
  return `${lines.slice(at + 1, end).map((l) => l.slice(10)).join("\n")}\n`;
}

/** The command in a script that runs changelog-section.mjs: its line to the end of its `{ }`, `if ... fi` or `\` lines. */
function gate(sh: string): string {
  const lines = sh.split("\n");
  const at = lines.findIndex((l) => l.includes(SCRIPT));
  if (at < 0) throw new Error(`no ${SCRIPT} in the script`);
  const indent = /^ */.exec(lines[at])?.[0] ?? "";
  const close = lines[at].trimEnd().endsWith("{") ? `${indent}}` : lines[at].trimStart().startsWith("if ") ? `${indent}fi` : "";
  let end = at;
  if (close) while (end < lines.length - 1 && lines[end] !== close) end++;
  else while (end < lines.length - 1 && lines[end].trimEnd().endsWith("\\")) end++;
  return `${lines.slice(at, end + 1).join("\n")}\n`;
}

/** A `gh` that prints `$GH_COMPARE` for `gh api` (and fails without it) and writes any other call's arguments to $GH_ARGS. */
const stub = mkdtempSync(join(tmpdir(), "genclass-gh-"));
writeFileSync(join(stub, "gh"), '#!/usr/bin/env bash\nif [ "$1" = api ]; then [ -n "$GH_COMPARE" ] || exit 1; echo "$GH_COMPARE"; exit 0; fi\nprintf \'%s\\n\' "$@" > "$GH_ARGS"\n');
chmodSync(join(stub, "gh"), 0o755);

afterAll(() => {
  for (const d of [dir, stub]) rmSync(d, { recursive: true, force: true });
});

/** Runs shell in bash -e (GitHub's default shell) from the repository root, with the stub gh and `env`. */
function sh(text: string, env: Record<string, string>) {
  const r = spawnSync("bash", ["-e", "-c", text], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stub}:${process.env.PATH}`, GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "genclass-dev/GenClass", RUNNER_TEMP: dir, GH_ARGS: join(dir, "gh-args"), ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The arguments `gh release create` got in the last run of the stub. */
const ghArgs = () => readFileSync(join(dir, "gh-args"), "utf8").trimEnd().split("\n");

const WORKFLOWS = [
  {
    file: ".github/workflows/release.yml",
    tagJob: "publish",
    notes: 'node .github/scripts/changelog-section.mjs packages/runtime/CHANGELOG.md "${GITHUB_REF_NAME#v}"',
    url: '--url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/blob/$GITHUB_REF_NAME/packages/runtime/CHANGELOG.md"',
    title: "@genclass/runtime",
  },
  {
    file: ".github/workflows/release-mcp.yml",
    tagJob: "publish",
    notes: 'node .github/scripts/changelog-section.mjs packages/mcp/CHANGELOG.md "${GITHUB_REF_NAME#mcp-v}" --or-link',
    url: '--url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/blob/$GITHUB_REF_NAME/packages/mcp/CHANGELOG.md"',
    title: "@genclass/mcp",
  },
  {
    file: ".github/workflows/release-packages.yml",
    tagJob: "build",
    notes: 'node .github/scripts/changelog-section.mjs "packages/$PKG/CHANGELOG.md" "${GITHUB_REF_NAME#"$PKG"-v}"',
    url: '--url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/blob/$GITHUB_REF_NAME/packages/$PKG/CHANGELOG.md"',
    title: "@genclass/$PKG",
  },
];

describe("the github-release job of release.yml, release-mcp.yml and release-packages.yml", () => {
  for (const w of WORKFLOWS) {
    const yml = read(w.file);
    const release = job(yml, "github-release");

    it(`${w.file}: the workflow's token only reads; only the github-release job may write, with github.token and no secret`, () => {
      expect(block(yml, "permissions", "")).toBe("permissions:\n  contents: read");
      expect(yml.match(/contents: write/g)).toHaveLength(1);
      expect(release).toMatch(/^ {6}contents: write /m);
      expect(yml.match(/GH_TOKEN:/g)).toHaveLength(1);
      expect(release).toContain("\n      GH_TOKEN: ${{ github.token }}\n");
      expect(release).not.toContain("id-token");
      expect(release).not.toContain("environment:");
      expect(yml).not.toMatch(/\$\{\{\s*secrets\./);
    });

    it(`${w.file}: the github-release job runs on a tag push after the publish job and creates the tag's release with the version's CHANGELOG section as its notes`, () => {
      expect(release).toContain(`\n    ${TAG_PUSH}\n`);
      expect(release).toMatch(/^ {4}needs: (?:publish|\[packages, publish\])$/m);
      expect(release).toContain("persist-credentials: false");
      expect(script(step(release, "Notes, the version's CHANGELOG section"))).toBe(`${w.notes} \\\n  ${w.url} > "$RUNNER_TEMP/notes.md"\n`);
      const create = script(step(release, "Create the release"));
      expect(create).toContain(`gh release create "$GITHUB_REF_NAME" --verify-tag `);
      expect(create).toContain(`--title "${w.title} $VERSION" --notes-file "$RUNNER_TEMP/notes.md"`);
      // a prerelease version: one with a "-", the publish step's test
      expect(create).toMatch(/\n {2}\*-\*\) (?:MARK=--prerelease|PRERELEASE=\(--prerelease\)) ;;\n/);
    });

    it(`${w.file}: the step that checks the tag runs the script before anything is installed or published`, () => {
      const tagJob = job(yml, w.tagJob);
      const check = step(tagJob, "The tag names the package version");
      const after = tagJob.indexOf(check) + check.length;
      expect(check).toContain(`${SCRIPT} `);
      expect(tagJob.indexOf("npm ci --no-audit --no-fund")).toBeGreaterThan(after);
      expect(tagJob.indexOf("npm publish")).toBeGreaterThan(after);
    });
  }

  it("release.yml: a version without a released section fails the step that checks the tag", () => {
    const check = gate(script(step(job(read(".github/workflows/release.yml"), "publish"), "The tag names the package version")));
    expect(sh(check, { PKG: "0.3.0-beta.5" })).toEqual({ code: 0, out: "", err: "" });
    const missing = sh(check, { PKG: "9.9.9" });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('::error::packages/runtime/CHANGELOG.md has no released section for 9.9.9: head it "## 9.9.9 (<date>)"');
  });

  it("release-packages.yml: a tag push without a released section fails the step that checks the tag; a pull request gets a notice", () => {
    const check = gate(script(step(job(read(".github/workflows/release-packages.yml"), "build"), "The tag names the package version")));
    const env = { GITHUB_WORKSPACE: repo, PKG: "playwright", VERSION: "9.9.9" };
    const push = sh(check, { ...env, GITHUB_EVENT_NAME: "push" });
    expect(push.code).toBe(1);
    expect(push.out).toContain('::error::packages/playwright/CHANGELOG.md has no released section for 9.9.9: head it "## 9.9.9 (<date>)"');
    const pr = sh(check, { ...env, GITHUB_EVENT_NAME: "pull_request" });
    expect(pr.code).toBe(0);
    expect(pr.out).toContain("::notice::packages/playwright/CHANGELOG.md has no released section for 9.9.9 yet");
    // a released section passes (the step only builds the path from $PKG)
    expect(sh(check, { GITHUB_WORKSPACE: repo, PKG: "mcp", VERSION: "0.2.2", GITHUB_EVENT_NAME: "push" })).toEqual({ code: 0, out: "", err: "" });
  });

  it("release-mcp.yml: a version without a section of its own only warns there (0.1.0 has none), and its notes link to the CHANGELOG", () => {
    const yml = read(".github/workflows/release-mcp.yml");
    const check = gate(script(step(job(yml, "publish"), "The tag names the package version")));
    expect(sh(check, { PKG: "0.2.2" })).toEqual({ code: 0, out: "", err: "" });
    const missing = sh(check, { PKG: "0.0.1" });
    expect(missing.code).toBe(0);
    expect(missing.out).toContain("::warning::packages/mcp/CHANGELOG.md has no released section for 0.0.1: the GitHub release will link to the CHANGELOG");
    const notes = script(step(job(yml, "github-release"), "Notes, the version's CHANGELOG section"));
    expect(sh(notes, { GITHUB_REF_NAME: "mcp-v0.0.1" }).code).toBe(0);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("See [packages/mcp/CHANGELOG.md](https://github.com/genclass-dev/GenClass/blob/mcp-v0.0.1/packages/mcp/CHANGELOG.md).\n");
    expect(sh(notes, { GITHUB_REF_NAME: "mcp-v0.2.2" }).code).toBe(0);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe(run("packages/mcp/CHANGELOG.md", "0.2.2", "--url", "https://github.com/genclass-dev/GenClass/blob/mcp-v0.2.2/packages/mcp/CHANGELOG.md").out);
    // the other two never fall back
    for (const file of [".github/workflows/release.yml", ".github/workflows/release-packages.yml"]) expect(read(file), file).not.toContain("--or-link");
  });

  it("release.yml's notes are the version's section, its links pointed at the tag", () => {
    const notes = script(step(job(read(".github/workflows/release.yml"), "github-release"), "Notes, the version's CHANGELOG section"));
    expect(sh(notes, { GITHUB_REF_NAME: "v0.3.0-beta.5" }).code).toBe(0);
    const at = "https://github.com/genclass-dev/GenClass/blob/v0.3.0-beta.5/packages/runtime/CHANGELOG.md";
    const written = readFileSync(join(dir, "notes.md"), "utf8");
    expect(written).toBe(run("packages/runtime/CHANGELOG.md", "0.3.0-beta.5", "--url", at).out);
    expect(written).not.toMatch(/\]\((?:\.\.\/|[A-Z]+\.md)/);
  });

  for (const file of [".github/workflows/release.yml", ".github/workflows/release-mcp.yml"]) {
    it(`${file}: a stable release becomes the latest one only when its tag is on the default branch; a prerelease never`, () => {
      const create = step(job(read(file), "github-release"), "Create the release");
      expect(create).toContain("DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}");
      expect(create).toContain('gh api "repos/$GITHUB_REPOSITORY/compare/$DEFAULT_BRANCH...$GITHUB_REF_NAME" --jq .status');
      const tag = file.endsWith("release-mcp.yml") ? "mcp-v" : "v";
      const flags = (version: string, compare: string) => {
        const r = sh(script(create), { GITHUB_REF_NAME: `${tag}${version}`, DEFAULT_BRANCH: "main", GH_COMPARE: compare });
        expect(r.code, r.err).toBe(0);
        const args = ghArgs();
        expect(args.slice(0, 4)).toEqual(["release", "create", `${tag}${version}`, "--verify-tag"]);
        return { args, out: r.out };
      };
      // on the default branch: behind its tip (an older commit) or at it
      for (const compare of ["behind", "identical"]) expect(flags("1.0.0", compare).args, compare).toContain("--latest");
      // a tag on a release branch (v0.2.3 is on release/0.2.3: "diverged"), one ahead of main, or a compare that failed
      for (const compare of ["diverged", "ahead", ""]) {
        const { args, out } = flags("1.0.1", compare);
        expect(args, compare).toContain("--latest=false");
        expect(args, compare).not.toContain("--latest");
        expect(out, compare).toContain("does not become the latest one");
      }
      const pre = flags("1.1.0-beta.1", "behind").args;
      expect(pre).toContain("--prerelease");
      expect(pre.filter((a) => a.startsWith("--latest"))).toEqual([]);
    });
  }

  it("release-packages.yml: never the latest release, for a stable version or a prerelease", () => {
    const create = script(step(job(read(".github/workflows/release-packages.yml"), "github-release"), "Create the release"));
    expect(sh(create, { GITHUB_REF_NAME: "playwright-v0.1.0", PKG: "playwright" }).code).toBe(0);
    expect(ghArgs()).toEqual(["release", "create", "playwright-v0.1.0", "--verify-tag", "--latest=false", "--title", "@genclass/playwright 0.1.0", "--notes-file", join(dir, "notes.md")]);
    expect(sh(create, { GITHUB_REF_NAME: "sv-v0.2.0-beta.1", PKG: "sv" }).code).toBe(0);
    expect(ghArgs()).toEqual(["release", "create", "sv-v0.2.0-beta.1", "--verify-tag", "--latest=false", "--prerelease", "--title", "@genclass/sv 0.2.0-beta.1", "--notes-file", join(dir, "notes.md")]);
  });

  it("mcp.yml runs this file when the script, a release workflow or the runtime CHANGELOG (its published sections are read above) changes", () => {
    const on = block(read(".github/workflows/mcp.yml"), "on", "");
    for (const trigger of ["push", "pull_request"]) {
      const paths = [...block(on, trigger, "  ").matchAll(/^ {6}- "([^"]+)"$/gm)].map((m) => m[1]);
      expect(paths, trigger).toEqual(expect.arrayContaining([".github/scripts/**", ".github/workflows/release.yml", ".github/workflows/release-mcp.yml", ".github/workflows/release-packages.yml", "packages/runtime/CHANGELOG.md"]));
    }
  });
});
