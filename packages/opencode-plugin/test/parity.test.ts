// The digest says exactly what `genclass-mcp hook` (the Claude Code UserPromptSubmit hook) says: both run against
// one stub bridge, each with its own project directory, and the additionalContext the hook prints equals the
// plugin's text. Imports @genclass/mcp's source from the workspace (a test-only path, not a dependency).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hookCmd } from "../../mcp/src/cli.js";
import { clean as mcpClean, q as mcpQ } from "../../mcp/src/text.js";
import { clean, digest, q } from "../src/digest.js";
import { findings, stubBridge, tempDir, type StubBridge } from "./helpers.js";

async function hook(cwd: string, env: Record<string, string>): Promise<string | null> {
  const out: string[] = [];
  await hookCmd({ cwd, env, out: (s) => out.push(s), err: () => {} } as never);
  if (!out.length) return null;
  return (JSON.parse(out.join("")) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

describe("parity with packages/mcp/src/cli.ts hookCmd", () => {
  let b: StubBridge;
  beforeEach(async () => {
    b = await stubBridge();
  });
  afterEach(() => b.close());

  it("the same answers give the same text, prompt after prompt", async () => {
    const a = tempDir();
    const c = tempDir();
    const answers = [
      { epoch: "e1", cursor: 3, findings: findings() },
      { epoch: "e1", cursor: 5, findings: findings() },
      { epoch: "e1", cursor: 6, findings: [] },
      { epoch: "e2", cursor: 1, findings: findings().slice(4) },
    ];
    for (const ans of answers) {
      b.answer = ans;
      const want = await hook(a, b.env);
      const got = await digest({ cwd: c, env: b.env });
      expect(got).toBe(want);
    }
    const ps = b.calls.map((x) => JSON.stringify(x.p));
    expect(ps.filter((_, i) => i % 2 === 0)).toEqual(ps.filter((_, i) => i % 2 === 1));
  });

  it("clean and q match @genclass/mcp's on hostile strings", () => {
    const xs = ["a\u0000b", "\u001b[31mred\u001b[0m", "x‮y⁦z", "tag\u{E0041}s", "a\n\tb  c", "😀".repeat(300), { a: 1 }, 3, null, undefined, "­soft"];
    for (const x of xs) {
      expect(clean(x, 50)).toBe(mcpClean(x, 50));
      expect(q(x, 80)).toBe(mcpQ(x, 80));
    }
  });
});
