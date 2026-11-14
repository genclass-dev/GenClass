// A reader that stops early (`genclass help | head -1`) closes the pipe: the command ends quietly, never with a stack
// trace (src/main.mjs). Runs the command from its sources through a real shell pipe.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolate, tempDir } from "./helpers.js";

isolate();
const MAIN = fileURLToPath(new URL("../src/main.mjs", import.meta.url));

describe("genclass piped into a reader that stops early (src/main.mjs)", () => {
  it("help | head -1 prints one line and no EPIPE stack trace", () => {
    const cfg = tempDir("genclass-cfg-");
    const r = spawnSync("sh", ["-c", `node "${MAIN}" help | head -1; echo "rc=\${PIPESTATUS:-0}"`], {
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: cfg, GENCLASS_HOST: "http://127.0.0.1:9", GENCLASS_NO_INSTALL: "1", GENCLASS_NO_UPDATE: "1", CI: "1" },
    });
    expect(r.stdout.split("\n")[0]).toContain("genclass");
    expect(r.stderr).not.toMatch(/EPIPE|Unhandled 'error' event|at .*genclass/);
  });
});
