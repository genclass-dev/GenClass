#!/usr/bin/env node
// genclass-playwright-run: runs your own Playwright with GenClass's register entry applied, with no change to your
// tests or your playwright.config (see src/run.ts). Every argument goes to "playwright test"; the exit code is its.
import { processRunIo, runCommand } from "../dist/run.js";

process.exitCode = await runCommand(process.argv.slice(2), processRunIo());
