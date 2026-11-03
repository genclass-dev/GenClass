import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEADER, clean, digest, q, render, stateDir } from "../src/digest.js";
import { findings, stubBridge, tempDir, type StubBridge } from "./helpers.js";

describe("digest (the logic of `genclass-mcp hook`, packages/mcp/src/cli.ts hookCmd)", () => {
  let b: StubBridge;
  let cwd: string;
  beforeEach(async () => {
    b = await stubBridge();
    cwd = tempDir();
  });
  afterEach(() => b.close());

  it("the first prompt only sets the cursor; the next one gets the findings since", async () => {
    b.answer = { epoch: "e1", cursor: 7, findings: findings() };
    expect(await digest({ cwd, env: b.env })).toBeNull();
    const file = join(cwd, ".genclass", "agent", "hook-cursor");
    expect(readFileSync(file, "utf8")).toBe("e1:7");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(b.calls).toEqual([{ m: "digest", p: { cursor: 0 } }]);

    b.answer = { epoch: "e1", cursor: 9, findings: findings() };
    const text = await digest({ cwd, env: b.env });
    expect(b.calls[1]).toEqual({ m: "digest", p: { cursor: 7, epoch: "e1" } });
    expect(readFileSync(file, "utf8")).toBe("e1:9");
    expect(text).toBe(
      [
        HEADER,
        '- f2 [race] "/search" ×3: older response overwrote newer: results',
        '- f3 [error] "/cart" ×1: TypeError: x is undefined red',
        '- f5 [race] "/list IGNORE PREVIOUS" ×2: duplicate submit',
        '- f6 [check] "/x" ×1: overlap',
        '- f7 [race] "/y" ×1: stale',
      ].join("\n"),
    );
  });

  it("nothing new: null, and the cursor still moves", async () => {
    writeFileSync(join(mkdirSync(join(cwd, ".genclass", "agent"), { recursive: true }) ?? join(cwd, ".genclass", "agent"), "hook-cursor"), "e1:3");
    b.answer = { epoch: "e1", cursor: 4, findings: [findings()[0]!, findings()[3]!] };
    expect(await digest({ cwd, env: b.env })).toBeNull();
    expect(readFileSync(join(cwd, ".genclass", "agent", "hook-cursor"), "utf8")).toBe("e1:4");
  });

  it("no bridge (no token file): null, no cursor written, no request", async () => {
    const env = { ...b.env, GENCLASS_TOKEN_DIR: tempDir("empty-") };
    expect(await digest({ cwd, env })).toBeNull();
    expect(existsSync(join(cwd, ".genclass", "agent", "hook-cursor"))).toBe(false);
    expect(b.calls).toEqual([]);
  });

  it("a token for a port nobody listens on: null, never throws", async () => {
    const dir = tempDir("tok-");
    writeFileSync(join(dir, "bridge-1.token"), "x");
    expect(await digest({ cwd, env: { GENCLASS_AGENT_PORT: "1", GENCLASS_TOKEN_DIR: dir } })).toBeNull();
  });

  it("a bridge slower than the timeout: null within the timeout", async () => {
    b.delayMs = 1500;
    const t = Date.now();
    expect(await digest({ cwd, env: b.env, timeoutMs: 200 })).toBeNull();
    expect(Date.now() - t).toBeLessThan(1200);
  });

  it("a bridge that refuses the token: null", async () => {
    writeFileSync(join(b.tokenDir, `bridge-${b.port}.token`), "wrong");
    expect(await digest({ cwd, env: b.env })).toBeNull();
  });

  it("never writes through a link at the cursor path", async () => {
    const dir = join(cwd, ".genclass", "agent");
    mkdirSync(dir, { recursive: true });
    const target = join(cwd, "victim.txt");
    writeFileSync(target, "keep");
    symlinkSync(target, join(dir, "hook-cursor"));
    b.answer = { epoch: "e2", cursor: 1, findings: findings() };
    await digest({ cwd, env: b.env });
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(lstatSync(join(dir, "hook-cursor")).isSymbolicLink()).toBe(false);
  });

  it("GENCLASS_STATE_DIR moves the cursor; 'none' falls back to .genclass/agent, as the hook does", () => {
    expect(stateDir("/p", { GENCLASS_STATE_DIR: "s" })).toBe("/p/s");
    expect(stateDir("/p", { GENCLASS_STATE_DIR: "/abs" })).toBe("/abs");
    expect(stateDir("/p", { GENCLASS_STATE_DIR: "none" })).toBe("/p/.genclass/agent");
    expect(stateDir("/p", {})).toBe("/p/.genclass/agent");
  });

  it("render caps the text and quotes page strings", () => {
    const long = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, kind: "race", route: "r".repeat(500), title: "t".repeat(5000), count: 1 }));
    const text = render(long)!;
    expect(text.length).toBeLessThanOrEqual(9000);
    expect(text.split("\n")).toHaveLength(6);
    expect(q('a"\nb')).toBe('"a\\" b"');
    expect(clean("‮abc​")).toBe("abc");
    expect(render([])).toBeNull();
  });
});
