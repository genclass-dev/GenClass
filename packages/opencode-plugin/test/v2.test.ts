import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { type V2Context, type V2McpEditor, type V2Prompt } from "../src/index.js";
import { HEADER } from "../src/digest.js";
import { findings, stubBridge, tempDir, type StubBridge } from "./helpers.js";

const mcpVersion = (JSON.parse(readFileSync(new URL("../../mcp/package.json", import.meta.url), "utf8")) as { version: string }).version;

/** A fake V2 context: an MCP editor over a map, and a session hook registry, as @opencode/plugin 2.2.5 types them. */
function fakeCtx(directory: string, servers: Map<string, unknown> = new Map(), options?: unknown) {
  const hooks: { name: string; cb: (e: V2Prompt) => Promise<void> | void }[] = [];
  const disposed: string[] = [];
  const editor: V2McpEditor = {
    get: (n) => servers.get(n),
    set: (n, c) => void servers.set(n, c),
  };
  const ctx: V2Context = {
    location: { directory },
    options,
    mcp: {
      transform: async (cb) => {
        cb(editor);
        return { dispose: async () => void disposed.push("mcp") };
      },
    },
    session: {
      hook: async (name, cb) => {
        hooks.push({ name, cb });
        return { dispose: async () => void disposed.push(name) };
      },
    },
  };
  return { ctx, servers, hooks, disposed };
}

describe("OpenCode 2.x: setup(ctx) (@opencode/plugin 2.2.5)", () => {
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

  it("the default export is a V2 definition: an id and a setup function (what Plugin.define returns)", () => {
    expect(typeof plugin.id).toBe("string");
    expect(plugin.id).toBe("genclass");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
    expect("tui" in plugin).toBe(false);
  });

  it("adds the genclass server when none is configured, pinned, without `disabled`", async () => {
    const f = fakeCtx(cwd);
    await plugin.setup(f.ctx);
    expect(f.servers.get("genclass")).toEqual({ type: "local", command: ["npx", "-y", `@genclass/mcp@${mcpVersion}`] });
  });

  it("leaves a configured genclass server alone", async () => {
    const mine = { type: "remote", url: "http://127.0.0.1:9/mcp" };
    const f = fakeCtx(cwd, new Map([["genclass", mine]]));
    await plugin.setup(f.ctx);
    expect(f.servers.get("genclass")).toBe(mine);
  });

  it("the prompt hook appends the digest to the prompt text from the second prompt on", async () => {
    const f = fakeCtx(cwd);
    await plugin.setup(f.ctx);
    expect(f.hooks.map((h) => h.name)).toEqual(["prompt"]);
    b.answer = { epoch: "e1", cursor: 1, findings: findings() };
    const e1: V2Prompt = { prompt: { text: "first" } };
    await f.hooks[0]!.cb(e1);
    expect(e1.prompt.text).toBe("first");
    const e2: V2Prompt = { prompt: { text: "why is search wrong" } };
    await f.hooks[0]!.cb(e2);
    expect(e2.prompt.text.startsWith(`why is search wrong\n\n${HEADER}\n- f2 [race]`)).toBe(true);
  });

  it("options { mcp: false, findings: false } register nothing; cleanup disposes what was registered", async () => {
    const off = fakeCtx(cwd, new Map(), { mcp: false, findings: false });
    await plugin.setup(off.ctx);
    expect(off.servers.size).toBe(0);
    expect(off.hooks).toEqual([]);

    const f = fakeCtx(cwd);
    const cleanup = await plugin.setup(f.ctx);
    await cleanup();
    expect(f.disposed).toEqual(["mcp", "prompt"]);
  });

  it("never throws: no bridge, a throwing editor, a context without domains", async () => {
    process.env.GENCLASS_TOKEN_DIR = tempDir("none-");
    mkdirSync(join(cwd, ".genclass", "agent"), { recursive: true });
    writeFileSync(join(cwd, ".genclass", "agent", "hook-cursor"), "e1:0");
    const f = fakeCtx(cwd);
    await plugin.setup(f.ctx);
    const e: V2Prompt = { prompt: { text: "x" } };
    await f.hooks[0]!.cb(e);
    expect(e.prompt.text).toBe("x");

    const bad = fakeCtx(cwd);
    (bad.ctx.mcp as { transform: unknown }).transform = async (cb: (e: V2McpEditor) => void) => {
      cb({ get: () => undefined, set: () => { throw new Error("schema"); } });
      return { dispose: async () => {} };
    };
    await expect(plugin.setup(bad.ctx)).resolves.toBeTypeOf("function");
    await expect(plugin.setup({ location: { directory: cwd } } as never)).resolves.toBeTypeOf("function");
  });
});
