# OpenCode: where GenClass goes, and how

Checked 2026-11-03 against the OpenCode binaries (`opencode-ai` 1.19.5 and `@opencode/cli` 2.2.5 from npm, run in
throwaway HOME directories), the published plugin APIs (`@opencode-ai/plugin` 1.19.5, `@opencode/plugin` 2.2.5) and
anomalyco/opencode at `dev` 79c80c7ca2c0bb24db98670f8fe0c1c0d5133630. opencode.ai was not reachable from the session
(its proxy refused the host), so the documentation pages below are quoted from the session brief's reading of them,
and everything this file says works was run with the binaries. Nothing here has been submitted. The prepared upstream
change and its report: [../contributions/opencode/](../contributions/opencode/README.md).

## Two OpenCode lines

- **OpenCode 1.x**: npm `opencode-ai` (1.19.5), plugin API `@opencode-ai/plugin`, docs at opencode.ai/docs. Config key
  `plugin`, MCP servers as a flat `mcp.<name>` map.
- **OpenCode 2.x**: npm `@opencode/cli` (2.2.5), plugin API `@opencode/plugin`, docs at opencode.ai/v2/docs (per the
  brief, Homebrew's default formula and Arch install 2.x). Config key `plugins`, MCP servers under `mcp.servers`; the
  flat 1.x `mcp.<name>` map still loads (checked: `genclass` listed and connected on 2.2.5).

## What is in place in GenClass

| What | Where | Works today |
|---|---|---|
| The MCP server by JSON | `opencode.json` `mcp.genclass` (`packages/mcp/README.md`, generated from `packages/mcp/src/clients.ts`) | yes, both lines (`npx -y @genclass/mcp@0.2.1`) |
| The MCP server from the command line | `opencode mcp add genclass -- npx -y @genclass/mcp@0.2.1` | yes; 1.19.5 writes the global `~/.config/opencode/opencode.jsonc` (when none exists), 2.2.5 the project's `opencode.json` (`--global` for the global one) |
| The `genclass` skill | `.claude/skills/genclass/` (`npx -y @genclass/mcp@0.2.1 init`) or `.agents/skills/genclass/` (`npx skills add genclass-dev/genclass-plugin -a opencode`, skills CLI 1.7.6) | yes on 1.19.5 (`opencode debug skill` lists it from both); 2.2.5 has no skill listing command, not checked |
| `/genclass-explore <url> <steps>` | `.opencode/commands/genclass-explore.md`, written by `init` when `.opencode/` exists | yes on 1.19.5 (`opencode debug config` lists the command) |
| The plugin `opencode-genclass` | `packages/opencode-plugin`: the server plus new findings in each prompt | not on npm: the owner publishes it (`.github/workflows/release-opencode.yml`, tag `opencode-v0.1.0`; the first version by hand from the workflow's tarball) |

## Where to list it, once `opencode-genclass` is on npm

1. **OpenCode's ecosystem page** (`packages/web/src/content/docs/ecosystem.mdx` in anomalyco/opencode, rendered at
   opencode.ai/docs/ecosystem): "Want to add your OpenCode related project to this list? Submit a PR." A Plugins
   table, rows appended at the end, links to the plugin's source. Documentation PRs are exempt from the linked-issue
   check (CONTRIBUTING.md, "Link Issues When Required"); base on `dev`; title `docs: ...`; the PR template's
   sections; "Long, AI-generated PR descriptions and issues may be ignored. Write a short explanation in your own
   words." Ready: [../contributions/opencode/upstream.patch](../contributions/opencode/upstream.patch) and
   [PR.md](../contributions/opencode/PR.md). No star threshold or promotional-PR rule was found.
2. **awesome-opencode** (github.com/awesome-opencode/awesome-opencode) and **opencode.cafe**: named on the ecosystem
   page as the community aggregators. Not prepared in this session (their entry formats were not read); a later
   session or the owner adds them after the ecosystem row.
3. **opencode.ai/docs/mcp-servers** ("You can submit a PR if you want to document other servers", per the brief): an
   MCP server page entry is possible without the plugin; not prepared here, because a server page there would only
   repeat the JSON block, and the plugin row is the stronger entry.

## When OpenCode 2.x becomes npm's `opencode` default

Switch the README's JSON block to `"mcp": { "servers": { "genclass": { "type": "local", "command": [...] } } }` (no
`enabled`; 2.x's field is `disabled`), and say `plugins` before `plugin` in the plugin's README. The plugin itself
already serves both lines from one export.
