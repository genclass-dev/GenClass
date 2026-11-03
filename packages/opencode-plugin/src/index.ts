// opencode-genclass: GenClass for OpenCode. One default export that both OpenCode lines load:
//
//   OpenCode 2.x (`@opencode/cli`, `@opencode/plugin`): `{ id, setup }`, the object `Plugin.define` returns (it is the
//   identity function in @opencode/plugin 2.2.5, so the package needs no runtime dependency). `setup(ctx)` adds the
//   GenClass MCP server through `ctx.mcp.transform` when no server named `genclass` is configured, and registers
//   `ctx.session.hook("prompt")`, which appends the findings digest to the prompt's text.
//   OpenCode 1.x (`opencode-ai` 1.18.29 and later, `@opencode-ai/plugin`): the same object's `server(input, options)`
//   returns V1 hooks: `config` sets `mcp.genclass` when it is not set (`??=`: the user's config wins), and
//   `chat.message` pushes the digest as one synthetic text part of the user's message.
//
// This is the shape OpenCode's V1 migration guide prescribes (opencode.ai/v2/docs/build/plugins/migrate-v1): V2 reads
// `id` and `setup`, V1 (`readV1Plugin`) reads `id` and `server`. The module has no named runtime exports: OpenCode's
// legacy V1 loader calls every exported function, and a non-function export is an error there.
//
// Invariants: nothing here throws into OpenCode (a rejected V1 hook fails the user's prompt); without a running
// GenClass bridge the hooks add nothing; the digest is recorded page data under a header saying so (src/digest.ts);
// the server entry pins @genclass/mcp's exact version (packages/mcp/test/manifests.test.ts keeps it in step).
// Options (`["opencode-genclass", { mcp: false }]` on V1, the plugin's options on V2): `mcp: false` leaves the MCP
// configuration alone, `findings: false` turns the per-prompt digest off.

import { digest } from "./digest.js";
import { v1PartId } from "./ids.js";

/** The MCP server's name in OpenCode's configuration. */
const NAME = "genclass";
/** The local server entry: the exact @genclass/mcp release, started by npx in the project directory. */
const SERVER = { type: "local" as const, command: ["npx", "-y", "@genclass/mcp@0.2.1"] };

/** The plugin's options (both lines pass a record of the user's choices). */
export interface GenClassOptions {
  /** Add the GenClass MCP server when the configuration has none named `genclass` (default true). */
  mcp?: boolean;
  /** Bring findings recorded since the last prompt into each prompt (default true). */
  findings?: boolean;
}

function on(options: unknown, key: keyof GenClassOptions): boolean {
  return !(options && typeof options === "object" && (options as Record<string, unknown>)[key] === false);
}

// ---- OpenCode 1.x (the fields of @opencode-ai/plugin 1.19.5's PluginInput, Hooks and TextPart this plugin uses) ----

/** The fields of OpenCode 1.x's plugin input this plugin reads. */
export interface V1Input {
  directory: string;
}

/** OpenCode 1.x's configuration, as far as the `config` hook touches it. */
export interface V1Config {
  mcp?: Record<string, unknown>;
}

/** A V1 text part (`TextPart` of @opencode-ai/sdk): ids start with `prt`, `msg` and `ses`. */
export interface V1TextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
}

/** The two V1 hooks this plugin returns. */
export interface V1Hooks {
  config: (input: V1Config) => Promise<void>;
  "chat.message": (
    input: { sessionID: string; messageID?: string },
    output: { message: { id: string; sessionID: string }; parts: unknown[] },
  ) => Promise<void>;
}

/** The V1 hooks for a project directory (the tests reach them through the default export's `server`). */
function v1Hooks(directory: string, options: unknown): V1Hooks {
  return {
    async config(cfg) {
      try {
        if (!on(options, "mcp") || !cfg || typeof cfg !== "object") return;
        cfg.mcp ??= {};
        cfg.mcp[NAME] ??= { type: SERVER.type, command: [...SERVER.command] };
      } catch {
        /* leave the configuration as it is */
      }
    },
    async "chat.message"(input, output) {
      try {
        if (!on(options, "findings")) return;
        const text = await digest({ cwd: directory });
        if (!text) return;
        const part: V1TextPart = {
          id: v1PartId(),
          sessionID: output.message?.sessionID ?? input.sessionID,
          messageID: output.message?.id ?? input.messageID ?? "",
          type: "text",
          text,
          synthetic: true,
        };
        output.parts.push(part);
      } catch {
        /* nothing to add */
      }
    },
  };
}

// ---- OpenCode 2.x (the fields of @opencode/plugin 2.2.5's promise Context this plugin uses) ----

/** Registration handle returned by V2 transforms and hooks. */
export interface V2Registration {
  readonly dispose: () => Promise<void>;
}

/** V2's MCP editor (`MCPEditor`), as far as this plugin uses it. */
export interface V2McpEditor {
  get(name: string): unknown;
  set(name: string, config: { type: "local"; command: string[] }): void;
}

/** V2's `session.hook("prompt")` input (`SessionPrompt`), as far as this plugin uses it. */
export interface V2Prompt {
  prompt: { text: string };
}

/** The fields of the V2 plugin context this plugin reads. */
export interface V2Context {
  readonly location: { readonly directory: string };
  readonly options?: unknown;
  readonly mcp: { readonly transform: (callback: (editor: V2McpEditor) => void) => Promise<V2Registration> };
  readonly session: { readonly hook: (name: "prompt", callback: (event: V2Prompt) => Promise<void> | void) => Promise<V2Registration> };
}

async function setup(ctx: V2Context): Promise<() => Promise<void>> {
  const regs: V2Registration[] = [];
  const options = ctx?.options;
  const directory = ctx?.location?.directory;
  if (on(options, "mcp")) {
    try {
      regs.push(
        await ctx.mcp.transform((editor) => {
          try {
            if (editor.get(NAME) === undefined) editor.set(NAME, { type: SERVER.type, command: [...SERVER.command] });
          } catch {
            /* leave the configuration as it is */
          }
        }),
      );
    } catch {
      /* no MCP domain: nothing to add */
    }
  }
  if (on(options, "findings") && typeof directory === "string") {
    try {
      regs.push(
        await ctx.session.hook("prompt", async (event) => {
          try {
            const text = await digest({ cwd: directory });
            if (!text || !event?.prompt) return;
            event.prompt.text = event.prompt.text ? `${event.prompt.text}\n\n${text}` : text;
          } catch {
            /* nothing to add */
          }
        }),
      );
    } catch {
      /* no session hooks: nothing to add */
    }
  }
  return async () => {
    for (const r of regs) {
      try {
        await r.dispose();
      } catch {
        /* already gone */
      }
    }
  };
}

/** The plugin: V2's `{ id, setup }` and V1's `server`, in one default export. */
const plugin = {
  id: "genclass",
  setup,
  async server(input: V1Input, options?: Record<string, unknown>): Promise<V1Hooks> {
    return v1Hooks(input?.directory ?? process.cwd(), options);
  },
};

export default plugin;
