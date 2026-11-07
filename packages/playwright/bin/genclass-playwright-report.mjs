#!/usr/bin/env node
// genclass-playwright-report: renders genclass-report.md from test-results/genclass/*.json and, with --comment,
// posts it on the pull request (see src/cli.ts).
import { runCli } from "../dist/cli.js";

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`genclass-playwright-report: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  },
);
