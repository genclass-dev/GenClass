// `genclass-playwright-report`: the reporter's last step as a command, for runs where the reporter is not in the
// Playwright config or where shards ran on several machines and their `test-results/genclass/` folders were
// collected into one place, and the pull-request comment step of a GitHub Actions job:
//
//   npx -p @genclass/playwright genclass-playwright-report [dir ...] [--out <file>|-] [--min-seeds <n>] [--max-chars <n>]
//     [--title <text>] [--no-footer] [--quiet] [--comment [--dry-run]]
//
// `-p @genclass/playwright` names the package the command comes from. Without it, outside a project that has the
// package installed, npx would look up a package named `genclass-playwright-report` on npm, a name GenClass does not
// own.
//
// Default dir `test-results/genclass`, default out `genclass-report.md` (`-`: print only), default --max-chars 60000
// (fits in a GitHub comment; 0: no limit); --no-footer leaves out the report's last line, the link to what its lines
// mean. Exit code 0 whenever the report was written, even with nothing flagged or files skipped (a report never fails
// a build); 1 when the report file could not be written; 2 on a usage error.
//
// --comment (GitHub Actions, src/comment.ts), once the report is written: adds it to the job summary and keeps one
// GenClass comment on the pull request up to date, created only when the report flags something and never a person's
// comment; skipped with a one-line notice outside pull_request runs, on forks and without GITHUB_TOKEN; an API or
// network error is a warning. Its lines go to stderr, and the exit code does not depend on them. --dry-run (with
// --comment) prints the requests instead of making them.

import { runCommentStep, type GitHubEnv } from "./comment.js";
import { DEFAULT_RACES_DIR, DEFAULT_REPORT_FILE, writeReport, type WrittenReport } from "./files.js";

export const USAGE =
  "usage: genclass-playwright-report [dir ...] [--out <file>|-] [--min-seeds <n>] [--max-chars <n>] [--title <text>] [--no-footer] [--quiet] [--comment [--dry-run]]\n";

export interface CliIo {
  cwd: string;
  out(s: string): void;
  err(s: string): void;
  /** The environment `--comment` reads (GITHUB_*). Default: process.env. */
  env?: GitHubEnv;
  /** The fetch `--comment` calls. Default: the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Runs the command with `argv` (without node and the script). Resolves to the exit code, which `--comment` does not
 * change. Never throws or rejects.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const dirs: string[] = [];
  let out: string | null = DEFAULT_REPORT_FILE;
  let minSeeds: number | undefined;
  let maxChars: number | undefined;
  let title: string | undefined;
  let footer = true;
  let quiet = false;
  let comment = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string | null => (i + 1 < argv.length ? argv[++i] : null);
    if (a === "--help" || a === "-h") {
      io.out(USAGE);
      return 0;
    } else if (a === "--out" || a === "-o") {
      const v = value();
      if (v === null || v === "") return usage(io, `${a} needs a file name (or - to print only)`);
      out = v === "-" ? null : v;
    } else if (a === "--min-seeds") {
      const v = value();
      const n = v === null ? NaN : Number(v);
      if (!Number.isInteger(n) || n < 1) return usage(io, `--min-seeds needs a whole number of at least 1, got ${v === null ? "nothing" : JSON.stringify(v)}`);
      minSeeds = n;
    } else if (a === "--max-chars") {
      const v = value();
      const n = v === null ? NaN : Number(v);
      if (!Number.isInteger(n) || n < 0) return usage(io, `--max-chars needs a whole number (0: no limit), got ${v === null ? "nothing" : JSON.stringify(v)}`);
      maxChars = n;
    } else if (a === "--title") {
      const v = value();
      if (v === null) return usage(io, "--title needs a text");
      title = v;
    } else if (a === "--no-footer") {
      footer = false;
    } else if (a === "--quiet" || a === "-q") {
      quiet = true;
    } else if (a === "--comment") {
      comment = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a.startsWith("-") && a !== "-") {
      return usage(io, `unknown option ${a}`);
    } else {
      dirs.push(a);
    }
  }
  if (dryRun && !comment) return usage(io, "--dry-run goes with --comment");
  let r: WrittenReport;
  try {
    r = writeReport({ dirs: dirs.length ? dirs : [DEFAULT_RACES_DIR], base: io.cwd, outputFile: out, minSeeds, maxChars, title, footer });
    if (!quiet || r.path === null) io.out(r.markdown);
    if (r.path) io.err(`GenClass report written to ${r.path}\n`);
  } catch (e) {
    io.err(`genclass-playwright-report: could not write the report: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (comment) {
    await runCommentStep({
      markdown: r.markdown,
      summary: r.summary,
      options: r.options,
      env: io.env ?? process.env,
      fetch: io.fetch ?? globalThis.fetch,
      dryRun,
      log: (line) => io.err(`genclass-playwright-report: ${line}\n`),
    });
  }
  return 0;
}

function usage(io: CliIo, why: string): number {
  io.err(`genclass-playwright-report: ${why}\n${USAGE}`);
  return 2;
}
