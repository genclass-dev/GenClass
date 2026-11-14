// The real-browser check of `genclass flake` (not in vitest's run: it needs Chromium and the built packages). It makes
// a tiny Playwright project in a temporary folder that names GenClass nowhere: a config whose web server is the search
// page of @genclass/playwright's own end-to-end check (packages/playwright/test/e2e/server.mjs: a buggy page where a
// slower older answer can land over newer results, and the fixed page that keeps only the latest), and one spec with
// four ordinary tests. Its node_modules links the built @genclass/runtime and @genclass/playwright of this checkout
// and this checkout's @playwright/test. Then it runs the built command, `genclass flake --json`, there, and requires:
//
//   - the buggy page's test (it asserts the results of the last query): racy, failing on at least one seed with
//     `overwrote-newer` on GET /api/search seen on a failing seed, and passing in the natural order;
//   - the fixed page's same test: passed on every run, with no race seen on any run (the false reports on the
//     correct variant: required to be 0);
//   - a test on the fixed page that fails on its third repeat only (a flake planted by the repeat index, which stands
//     for an ordinary flaky test: timing, isolation): flaky, failing on seed 3 only, with no race seen there;
//   - a test that asserts what the page never shows: broken;
//   - then the replay command the run printed for the racy test: run as it is, it fails again on that seed with the
//     same race (the seed reproduces the order).
// It prints the verdicts and the numbers. Nothing in the fixture is tuned to GenClass: the tests are what a project has.
//
// Usage: npm run build -w @genclass/runtime && npm run build -w @genclass/playwright && npm run build -w genclass
//        node packages/cli/test/e2e/flake.e2e.mjs [--runs N] [--keep]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const cli = join(repo, "packages/cli/bin/genclass.mjs");
const server = join(repo, "packages/playwright/test/e2e/server.mjs");
const argv = process.argv.slice(2);
const runs = argv.includes("--runs") ? Number(argv[argv.indexOf("--runs") + 1]) : 5;
const keep = argv.includes("--keep");
/** The longest one command may take (two runs of four tests, a browser start, a web server start each). */
const LIMIT_MS = 300_000;

for (const need of [join(repo, "packages/runtime/dist/genclass.global.js"), join(repo, "packages/playwright/dist/run.js"), join(repo, "packages/cli/dist/genclass.mjs"), join(repo, "node_modules/@playwright/test/package.json")]) {
  if (!existsSync(need)) {
    console.error(`flake e2e: ${need} is missing. Build first: npm run build -w @genclass/runtime && npm run build -w @genclass/playwright && npm run build -w genclass`);
    process.exit(2);
  }
}

const freePort = () =>
  new Promise((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

const CONFIG = (port) => `// A Playwright project as a repository has it: nothing here names GenClass.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\\.spec\\.ts/,
  workers: 1,
  timeout: 30_000,
  globalTimeout: 240_000,
  reporter: [["list"]],
  projects: [{ name: "chromium" }],
  webServer: { command: ${JSON.stringify(`node ${JSON.stringify(server)} ${port}`)}, url: "http://127.0.0.1:${port}/", reuseExistingServer: false, timeout: 30_000 },
  use: { baseURL: "http://127.0.0.1:${port}", headless: true },
});
`;

const SPEC = `// Four ordinary tests of a search page.
import { expect, test } from "@playwright/test";

async function searchFor(page, path, query) {
  let answered = 0;
  page.on("requestfinished", (r) => {
    if (new URL(r.url()).pathname === "/api/search") answered++;
  });
  await page.goto(path);
  await page.getByLabel("Search").pressSequentially(query, { delay: 80 });
  await expect.poll(() => answered, { timeout: 15_000 }).toBe(query.length);
}

test.describe("search", () => {
  test("buggy page shows the results of the last query", async ({ page }) => {
    await searchFor(page, "/", "react");
    await expect(page.locator("#for")).toHaveText("Results for react", { timeout: 1500 });
  });

  test("fixed page shows the results of the last query", async ({ page }) => {
    await searchFor(page, "/?fixed=1", "react");
    await expect(page.locator("#for")).toHaveText("Results for react", { timeout: 1500 });
  });

  test("fixed page, a flaky check", async ({ page }) => {
    await searchFor(page, "/?fixed=1", "vue");
    // stands for an ordinary flake (timing, isolation): it fails on the third repeat, whatever the network did
    expect(test.info().repeatEachIndex === 2 ? "flaked" : "ok").toBe("ok");
  });

  test("shows a heading it never shows", async ({ page }) => {
    await page.goto("/?fixed=1");
    await expect(page.locator("#for")).toHaveText("Results for nothing", { timeout: 500 });
  });
});
`;

function runCli(args, cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, "flake", ...args], { cwd, env: { ...process.env, GENCLASS_NO_INSTALL: "1", GENCLASS_NO_UPDATE: "1", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, LIMIT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, out, err });
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "genclass-flake-e2e-"));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
try {
  const port = await freePort();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "flake-fixture", private: true, type: "module" }, null, 2));
  writeFileSync(join(dir, "playwright.config.ts"), CONFIG(port));
  writeFileSync(join(dir, "search.spec.ts"), SPEC);
  mkdirSync(join(dir, "node_modules", "@genclass"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "@playwright"), { recursive: true });
  symlinkSync(join(repo, "packages/playwright"), join(dir, "node_modules/@genclass/playwright"), "dir");
  symlinkSync(join(repo, "packages/runtime"), join(dir, "node_modules/@genclass/runtime"), "dir");
  symlinkSync(join(repo, "node_modules/@playwright/test"), join(dir, "node_modules/@playwright/test"), "dir");

  const t0 = Date.now();
  const first = await runCli(["--json", "--runs", String(runs)], dir);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  let j = null;
  try {
    j = JSON.parse(first.out);
  } catch {
    console.error(first.err.slice(-4000));
    throw new Error(`genclass flake --json did not print JSON (exit ${first.code})`);
  }
  console.log(`genclass flake --json --runs ${runs}: exit ${first.code} in ${secs} s; ${j.totals?.tests} tests: ${JSON.stringify(j.totals)}`);
  const by = (title) => j.tests.find((t) => t.test === `search › ${title}`);
  const buggy = by("buggy page shows the results of the last query");
  const fixed = by("fixed page shows the results of the last query");
  const flaky = by("fixed page, a flaky check");
  const broken = by("shows a heading it never shows");
  for (const t of j.tests) console.log(`  ${t.verdict.padEnd(6)} ${t.file}:${t.line} ${t.test}: failed seeds [${t.failed_seeds}], natural ${t.natural}, races ${t.races.map((g) => `${g.kind} ${g.op} on failing seeds [${g.failing_seeds}] passing [${g.passing_seeds}]`).join("; ") || "none"}`);
  check(first.code === 1, "exit code 1 (a test did not pass every time)");
  check(j.runs?.natural === true && j.runs.seeds.length === runs, `the natural order and ${runs} seeds`);
  check(buggy?.verdict === "racy", "the buggy page's test is racy");
  check(buggy?.natural === "passed", "it passed in the natural order");
  check(!!buggy?.races.some((g) => g.kind === "overwrote-newer" && g.op === "GET /api/search" && g.failing_seeds.length > 0), "with overwrote-newer on GET /api/search on a failing seed");
  check(fixed?.verdict === "passed", "the fixed page's test passed every time");
  check(!!fixed && fixed.races.length === 0 && fixed.also_seen.length === 0 && fixed.runs.every((r) => r.races.length === 0), "no race seen on any run of the fixed page (false reports on the correct variant: 0)");
  check(flaky?.verdict === "flaky" && JSON.stringify(flaky.failed_seeds) === "[3]" && flaky.watched_failing_runs === 1, "the planted flake is flaky: seed 3 only, watched, no race");
  check(broken?.verdict === "broken", "the test that asserts what the page never shows is broken");
  check(typeof j.replay === "string" && /^(npx )?genclass flake search\.spec\.ts:\d+ /.test(j.replay) && / --seed \d+$/.test(j.replay), `one replay command: ${j.replay}`);
  check(typeof j.prompt === "string" && /Reproduce: (npx )?genclass flake /.test(j.prompt), "a prompt for the coding agent");

  // the replay, as printed (its words after "npx genclass flake")
  if (buggy?.replay) {
    const words = buggy.replay.replace(/^(npx )?genclass flake /, "").split(" ");
    const t1 = Date.now();
    const again = await runCli([...words, "--json"], dir);
    const r = JSON.parse(again.out);
    const t = r.tests[0];
    console.log(`replay ${buggy.replay}: exit ${again.code} in ${((Date.now() - t1) / 1000).toFixed(1)} s: ${t?.verdict}, failed seeds [${t?.failed_seeds}], races ${t?.races.map((g) => `${g.kind} ${g.op}`).join("; ") || "none"}`);
    check(r.tests.length === 1 && t.verdict === "racy" && t.failed_seeds.length === 1 && t.races.some((g) => g.kind === "overwrote-newer"), "the replay fails again on that seed with the same race");
  }
} catch (e) {
  failures.push(String(e?.message ?? e));
  console.error(`FAIL ${e?.message ?? e}`);
} finally {
  if (keep) console.log(`kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
