// One version's section of a CHANGELOG, printed as the notes of that version's GitHub release. The release workflows
// run it (release.yml, release-mcp.yml, release-packages.yml): first in the step that checks the tag, so a missing
// section fails before npm has anything (release-mcp.yml only warns there), then in the github-release job, which
// hands the output to `gh release create --notes-file`. packages/mcp/test/release-notes.test.ts checks it.
//
//   node .github/scripts/changelog-section.mjs <CHANGELOG.md> <version> [--url <url>] [--or-link]
//
// The section is the text under the heading that names the version (`## 0.2.2 (2026-11-05)`; `[0.2.2]` and `v0.2.2`
// match too, `0.2.20` and `0.2.2-beta.1` do not), up to the next heading of the same or a higher level; headings in
// code fences do not count. The heading and the blank lines around the text are left out: the release's title names
// the version.
//   --url <url>  the CHANGELOG's address at the release's tag. Relative links in the section are made absolute
//                against it: on a release page they would resolve against /releases/tag/ and lead nowhere.
//   --or-link    when there is no section to print, print one line that links to the CHANGELOG at --url and exit 0.
//
// Exits 0 with the section on stdout; 1 when the CHANGELOG has no heading for the version, the heading says
// unreleased or the section is empty (nothing on stdout, the reason on stderr); 2 on a usage error or a file it
// cannot read. GitHub refuses release notes over 125,000 characters, so a longer section is cut at a line and ends
// with a line that links to the rest. Node built-ins only.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const USAGE = "usage: node .github/scripts/changelog-section.mjs <CHANGELOG.md> <version> [--url <url>] [--or-link]";

/** GitHub refuses a release whose notes are longer ("body is too long (maximum is 125000 characters)"). */
const RELEASE_NOTES_MAX = 125000;

/** The run of backticks or tildes that opens a code fence on this line, or "". */
const fenceOpens = (line) => /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? "";

/** Whether this line closes the code fence that `fence` opened (the same character, at least as many). */
function fenceCloses(line, fence) {
  const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
  return close !== undefined && close[0] === fence[0] && close.length >= fence.length;
}

/** An ATX heading (`## 0.2.2 (2026-11-05)`): its level and text, or null for any other line. */
function heading(line) {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
  return m ? { level: m[1].length, text: (m[2] ?? "").replace(/(?:^|[ \t]+)#+$/, "") } : null;
}

/** The version a heading's text names: its first word, without `[...]` (and a link after it) or a leading `v`. */
const named = (text) => (text.split(/\s+/)[0] ?? "").replace(/^\[([^\]]*)\](?:\([^)]*\))?$/, "$1").replace(/^v(?=\d)/, "");

/**
 * `section`: the text of the heading that names `version` and the lines under it, up to the next heading of its level
 * or a higher one, outside code fences; undefined when no heading names it. `unreleased`: whether a heading before the
 * section's end is `Unreleased` (for the message when the version has no heading).
 */
function find(lines, version) {
  let fence = "";
  let unreleased = false;
  let at = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (fenceCloses(line, fence)) fence = "";
      continue;
    }
    fence = fenceOpens(line);
    if (fence) continue;
    const h = heading(line);
    if (!h) continue;
    if (at >= 0 && h.level <= level) return { section: { text: heading(lines[at]).text, lines: lines.slice(at + 1, i) }, unreleased };
    if (at < 0 && named(h.text) === version) {
      at = i;
      level = h.level;
    }
    if (named(h.text).toLowerCase() === "unreleased") unreleased = true;
  }
  return { section: at >= 0 ? { text: heading(lines[at]).text, lines: lines.slice(at + 1) } : undefined, unreleased };
}

/**
 * Inline links and images (`[text](target)`) and link reference definitions (a line `[label]: target`, with an
 * optional title), outside code spans; the groups name the part before the target and the target.
 */
const LINKS = /(`+).*?\1|(\]\([ \t]*)(<[^<>]*>|[^\s()<>]+)|^( {0,3}\[[^\]]+\]:[ \t]*)(<[^<>]*>|\S+)(?=[ \t]*(?:"[^"]*"|'[^']*'|\([^)]*\))?[ \t]*$)/g;

/** `lines` with every relative link target made absolute against `base`; code fences and code spans stay as they are. */
function absolute(lines, base) {
  const fix = (target) => {
    const angled = target.startsWith("<");
    const bare = angled ? target.slice(1, -1) : target;
    // absolute (`https:`, `mailto:`) and root-relative targets stay; a relative one, an anchor included, now names
    // the CHANGELOG's own address
    if (bare === "" || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(bare)) return target;
    let href;
    try {
      href = new URL(bare, base).href;
    } catch {
      return target;
    }
    return angled ? `<${href}>` : href;
  };
  let fence = "";
  return lines.map((line) => {
    if (fence) {
      if (fenceCloses(line, fence)) fence = "";
      return line;
    }
    fence = fenceOpens(line);
    if (fence) return line;
    return line.replace(LINKS, (m, ticks, inline, inlineTarget, def, defTarget) => {
      if (ticks !== undefined) return m;
      return inline !== undefined ? inline + fix(inlineTarget) : def + fix(defTarget);
    });
  });
}

/** Runs the command; returns its exit code. */
function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { url: { type: "string" }, "or-link": { type: "boolean" } } });
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = args;
  if (positionals.length !== 2 || positionals[1] === "") {
    console.error(USAGE);
    return 2;
  }
  const [file, asked] = positionals;
  const version = asked.replace(/^v(?=\d)/, "");
  let base;
  if (values.url !== undefined) {
    try {
      base = new URL(values.url);
    } catch {
      console.error(`--url ${values.url} is not a URL\n${USAGE}`);
      return 2;
    }
  }
  if (values["or-link"] && !base) {
    console.error(`--or-link needs --url, the address it links to\n${USAGE}`);
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`cannot read ${file}: ${e instanceof Error ? e.message : e}`);
    return 2;
  }

  const { section, unreleased } = find(text.split(/\r?\n/), version);
  const lines = section ? section.lines.slice() : [];
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  let reason = "";
  if (!section) {
    reason = `${file} has no heading for ${version}`;
    if (unreleased) reason += ` (its Unreleased section needs the version and a date in its heading: "## ${version} (<date>)")`;
  } else if (/\bunreleased\b/i.test(section.text.slice(section.text.split(/\s+/)[0].length))) {
    reason = `${file}: the heading for ${version} says unreleased ("${section.text}"); date it before the release`;
  } else if (lines.length === 0) {
    reason = `${file}: the section for ${version} is empty`;
  }
  if (reason) {
    if (!values["or-link"]) {
      console.error(reason);
      return 1;
    }
    console.error(`${reason}; printed a link to the CHANGELOG instead`);
    process.stdout.write(`See [${file}](${base.href}).\n`);
    return 0;
  }

  let notes = (base ? absolute(lines, base) : lines).join("\n");
  if (notes.length + 1 > RELEASE_NOTES_MAX) {
    const where = base ? `[${file}](${base.href})` : file;
    const tail = `\n\nThe rest of this section is in ${where}: GitHub takes at most 125,000 characters of release notes.`;
    const room = RELEASE_NOTES_MAX - tail.length - 1;
    const cut = notes.lastIndexOf("\n", room);
    notes = notes.slice(0, cut > 0 ? cut : room).trimEnd() + tail;
    console.error(`${file}: the section for ${version} is longer than a GitHub release takes; cut at a line, with a link to the rest`);
  }
  process.stdout.write(`${notes}\n`);
  return 0;
}

process.exitCode = main();
