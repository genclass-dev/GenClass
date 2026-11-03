# opencode-genclass

GenClass for [OpenCode](https://github.com/anomalyco/opencode): one plugin that

- **adds the GenClass MCP server** ([`@genclass/mcp`](https://www.npmjs.com/package/@genclass/mcp), started as
  `npx -y @genclass/mcp@0.2.1`) to OpenCode's configuration when you have not configured a server named `genclass`
  yourself (yours always wins), and
- **brings new findings into each prompt**: before a prompt goes to the model, it asks the GenClass bridge on
  127.0.0.1 for findings recorded in your app's pages since the last prompt (at most 5, 800 ms timeout) and adds
  them under a header that says they are recorded data, not instructions. This is what the Claude Code plugin's
  `UserPromptSubmit` hook does (`genclass-mcp hook`), with the same cursor file and the same wording.

The MCP server gives the agent what happened in your pages, in order (clicks, requests, the order responses arrived,
state writes, errors), `genclass_explore` (your steps run again with the network answering in different orders, to
find race conditions), `genclass_replay` (one exact order delivered again, before and after a fix) and the generated
Playwright regression test. Everything stays on your machine. The plugin has no dependencies.

It works on both OpenCode lines: **OpenCode 2.x** (`@opencode/cli`, checked with 2.2.5) and **OpenCode 1.x**
(`opencode-ai` 1.18.29 or later, checked with 1.19.5), from one default export, as OpenCode's V1 migration guide
describes.

## Install

OpenCode installs the package from npm when it starts.

**OpenCode 2.x**: `opencode.json` in the project, or `~/.config/opencode/opencode.json` for every project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-genclass"]
}
```

or `opencode plugin add opencode-genclass` (it writes the global configuration).

**OpenCode 1.x**: the key is `plugin`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-genclass"]
}
```

or `opencode plugin opencode-genclass` (`--global` for the global configuration).

Then connect your app's development build once (the agent link needs `@genclass/runtime` 0.3.0-beta.1 or later,
`npm install @genclass/runtime@beta`):

```ts
import { GenClass } from "@genclass/runtime";
import { connectAgent } from "@genclass/runtime/agent";

const rt = GenClass.init();
if (import.meta.env.DEV) connectAgent(rt); // Next.js: process.env.NODE_ENV === "development"
```

Load a page of the dev server and ask the agent for `genclass_status`.

## Options

Both lines pass options to the plugin: `["opencode-genclass", { "mcp": false }]` on 1.x,
`{ "package": "opencode-genclass", "options": { "mcp": false } }` on 2.x.

| option | default | what it does |
|---|---|---|
| `mcp` | `true` | add the `genclass` MCP server when none is configured; `false` leaves the MCP configuration alone (for example when you run the server under another name) |
| `findings` | `true` | add the findings recorded since the last prompt to each prompt; `false` turns that off |

The environment variables of `@genclass/mcp` apply: `GENCLASS_AGENT_PORT` (default 47357), `GENCLASS_STATE_DIR`
(where the cursor file `hook-cursor` lives, default `.genclass/agent` in the project), `GENCLASS_TOKEN_DIR` (the
bridge's token file, default `~/.genclass`).

## What it adds, exactly

- **2.x**: `setup(ctx)` calls `ctx.mcp.transform` and sets `genclass` to
  `{ "type": "local", "command": ["npx", "-y", "@genclass/mcp@0.2.1"] }` only when `editor.get("genclass")` is
  undefined, and registers `ctx.session.hook("prompt")`, which appends the findings to the prompt's text after a
  blank line.
- **1.x**: `server()` returns a `config` hook (`config.mcp.genclass ??= { type: "local", command: [...] }`) and a
  `chat.message` hook that pushes the findings as one synthetic text part of your message (OpenCode stores it with
  the message, and the model reads it; synthetic parts are OpenCode's own convention for text it adds to a message).
- The first prompt in a project only sets the cursor (ask the agent for `genclass_findings` for the backlog); no
  bridge running means nothing is added; the hooks never throw into OpenCode. The plugin sends nothing anywhere
  except the one request to the bridge on 127.0.0.1.

Removing it: delete the entry from `plugin`/`plugins` (2.x: `opencode plugin remove opencode-genclass`). The cursor
file is `.genclass/agent/hook-cursor` in the project.

## Licence

Apache-2.0. Source: [packages/opencode-plugin](https://github.com/genclass-dev/GenClass-lib/tree/main/packages/opencode-plugin)
in the GenClass repository.
