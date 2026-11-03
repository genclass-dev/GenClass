# Changelog

Changes to `opencode-genclass`, the OpenCode plugin for [`@genclass/mcp`](https://www.npmjs.com/package/@genclass/mcp).
Version 0.1.0 is not on npm yet; everything below is unreleased.

## Unreleased

- **The plugin** (0.1.0): one default export that OpenCode 2.x reads as a `Plugin.define` definition (`id`,
  `setup`) and OpenCode 1.18.29 and later read as an object entrypoint (`id`, `server`). It adds the `genclass` MCP
  server (`npx -y @genclass/mcp@0.2.1`, type local) when none is configured (2.x: `ctx.mcp.transform`; 1.x: the
  `config` hook, `??=`), and brings up to 5 findings recorded since the last prompt into each prompt (2.x: the
  `prompt` session hook appends them to the text; 1.x: `chat.message` pushes one synthetic text part), with the
  logic, cursor file and wording of `genclass-mcp hook`. Options `mcp: false` and `findings: false`. No
  dependencies.
