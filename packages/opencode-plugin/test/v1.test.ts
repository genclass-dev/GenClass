import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { v1PartId } from "../src/ids.js";
import { HEADER } from "../src/digest.js";
import { findings, stubBridge, tempDir, type StubBridge } from "./helpers.js";

const mcpVersion = (JSON.parse(readFileSync(new URL("../../mcp/package.json", import.meta.url), "utf8")) as { version: string }).version;

describe("OpenCode 1.x: server() hooks (@opencode-ai/plugin 1.19.5)", () => {
  let b: StubBridge;
  let cwd: string;
  const saved = { ...process.env };
  beforeEach(async () => {
    b = await stubBridge();
    cwd = tempDir();
    Object.assign(process.env, b.env);
  });
  afterEach(async () => {
    process.env = { ...saved };
    await b.close();
  });

  it("config adds mcp.genclass to an empty config, pinned to @genclass/mcp's version, with no `enabled` key", async () => {
    const hooks = await plugin.server({ directory: cwd });
    const cfg: { mcp?: Record<string, unknown> } = {};
    await hooks.config(cfg);
    expect(cfg).toEqual({ mcp: { genclass: { type: "local", command: ["npx", "-y", `@genclass/mcp@${mcpVersion}`] } } });
  });

  it("config leaves the user's own genclass entry and other servers alone", async () => {
    const hooks = await plugin.server({ directory: cwd });
    const mine = { type: "local", command: ["node", "my/genclass.js"], enabled: false };
    const cfg = { mcp: { genclass: mine, other: { type: "remote", url: "https://x" } } };
    await hooks.config(cfg);
    expect(cfg.mcp.genclass).toBe(mine);
    expect(Object.keys(cfg.mcp)).toEqual(["genclass", "other"]);
  });

  it("config with { mcp: false } changes nothing; a broken config never throws", async () => {
    const off = await plugin.server({ directory: cwd }, { mcp: false });
    const cfg = {};
    await off.config(cfg);
    expect(cfg).toEqual({});
    const hooks = await plugin.server({ directory: cwd });
    await expect(hooks.config(null as never)).resolves.toBeUndefined();
    const frozen = Object.freeze({ mcp: Object.freeze({}) });
    await expect(hooks.config(frozen as never)).resolves.toBeUndefined();
  });

  it("chat.message: nothing on the first prompt, then one synthetic text part with the digest", async () => {
    const hooks = await plugin.server({ directory: cwd });
    b.answer = { epoch: "e1", cursor: 2, findings: findings() };
    const message = { id: "msg_1", sessionID: "ses_1" };
    const parts: unknown[] = [{ id: "prt_0", type: "text", text: "fix the search page" }];
    await hooks["chat.message"]({ sessionID: "ses_1", messageID: "msg_1" }, { message, parts });
    expect(parts).toHaveLength(1);

    await hooks["chat.message"]({ sessionID: "ses_1" }, { message, parts });
    expect(parts).toHaveLength(2);
    const p = parts[1] as Record<string, unknown>;
    expect(p).toMatchObject({ type: "text", sessionID: "ses_1", messageID: "msg_1", synthetic: true });
    expect(String(p.id)).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(String(p.text).startsWith(`${HEADER}\n- f2 [race]`)).toBe(true);
  });

  it("chat.message without a bridge, or with { findings: false }: nothing, never throws", async () => {
    const off = await plugin.server({ directory: cwd }, { findings: false });
    mkdirSync(join(cwd, ".genclass", "agent"), { recursive: true });
    writeFileSync(join(cwd, ".genclass", "agent", "hook-cursor"), "e1:0");
    b.answer = { epoch: "e1", cursor: 2, findings: findings() };
    const parts: unknown[] = [];
    await off["chat.message"]({ sessionID: "s" }, { message: { id: "m", sessionID: "s" }, parts });
    expect(parts).toEqual([]);
    expect(b.calls).toEqual([]);

    process.env.GENCLASS_TOKEN_DIR = tempDir("none-");
    const hooks = await plugin.server({ directory: cwd });
    await hooks["chat.message"]({ sessionID: "s" }, { message: { id: "m", sessionID: "s" }, parts });
    expect(parts).toEqual([]);
    await expect(hooks["chat.message"]({ sessionID: "s" }, null as never)).resolves.toBeUndefined();
  });

  it("part ids follow OpenCode's ascending format and sort after the ids OpenCode made earlier in the same millisecond", () => {
    const zero = () => new Uint8Array(14);
    const ms = 1_793_000_000_000;
    const ours = v1PartId(ms, zero);
    expect(ours).toMatch(/^prt_[0-9a-f]{12}0{14}$/);
    // OpenCode's create(): (ms * 0x1000 + counter), low 48 bits, as 12 hex digits, then 14 base62 characters
    const theirs = (counter: number) => {
      const v = BigInt(ms) * 0x1000n + BigInt(counter);
      let hex = "";
      for (let i = 0; i < 6; i++) hex += Number((v >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
      return `prt_${hex}zzzzzzzzzzzzzz`;
    };
    expect(ours > theirs(1)).toBe(true);
    expect(ours > theirs(4094)).toBe(true);
    expect(ours < theirs(0x1000 + 1)).toBe(true); // the next millisecond's first id
  });
});
