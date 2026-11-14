// The starter templates (templates/*): each has a .gitignore, so an app copied from one (npx degit) never commits its
// dependencies, its build output, its .env files, test output or GenClass's .genclass.local (the app token and the
// private dashboard link), and none of those patterns hides a file the template ships.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEMPLATES = fileURLToPath(new URL("../../../templates/", import.meta.url));
const names = readdirSync(TEMPLATES).filter((n) => statSync(join(TEMPLATES, n)).isDirectory());

/**
 * The template's own files, relative paths: what git tracks there (a template someone ran npm install in has a
 * node_modules folder the repository does not ship), else every file but dependencies.
 */
function files(dir: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", "."], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const tracked = out.split("\0").filter(Boolean);
    if (tracked.length) return tracked;
  } catch {
    /* no git here */
  }
  const walk = (at: string): string[] =>
    readdirSync(join(dir, at)).flatMap((n) => {
      const rel = at ? `${at}/${n}` : n;
      if (n === "node_modules") return [];
      return statSync(join(dir, rel)).isDirectory() ? walk(rel) : [rel];
    });
  return walk("");
}

describe("starter templates: a .gitignore in each (templates/*)", () => {
  it("ignores node_modules, build output, .env files, test output and .genclass.local", () => {
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const name of names) {
      const file = join(TEMPLATES, name, ".gitignore");
      expect(existsSync(file), name).toBe(true);
      const lines = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      for (const need of ["node_modules", ".env", ".env.local", ".env.*.local", "test-results", "playwright-report", ".genclass.local"]) expect(lines, `${name}: ${need}`).toContain(need);
      // and the framework's build output
      const build = { nextjs: ".next", sveltekit: ".svelte-kit", nuxt: ".output", astro: "dist", "react-router": "build", angular: "dist", "react-vite": "dist", "vue-vite": "dist" }[name];
      if (build) expect(lines, `${name}: ${build}`).toContain(build);
    }
  });

  it("hides none of the files a template ships", () => {
    for (const name of names) {
      const patterns = readFileSync(join(TEMPLATES, name, ".gitignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      const res = patterns.map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`));
      for (const rel of files(join(TEMPLATES, name))) {
        if (rel === ".gitignore") continue;
        for (const seg of rel.split("/")) expect(res.some((re) => re.test(seg)), `${name}/${rel}`).toBe(false);
      }
    }
  });
});
