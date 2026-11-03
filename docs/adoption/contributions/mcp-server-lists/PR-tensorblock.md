# Pull request to TensorBlock/awesome-mcp-servers

Target: https://github.com/TensorBlock/awesome-mcp-servers, base `main`. The repository has no pull request template,
so the body follows the merged one-bullet PRs: two or three lines, then the disclosure. Tick **Allow edits by
maintainers** when opening it.

## Title

```
Add GenClass to Code Analysis & Quality
```

## Body

```markdown
Adds one bullet for GenClass to `docs/code-analysis--quality.md`, next to the other QA servers for web apps (after `Aboudjem/sniff`), and a metadata sidecar, `data/server-metadata/github-genclass-dev-genclass-cafd8990.json`, that adds the tool names, docs link and client list.

- Repository: https://github.com/genclass-dev/GenClass (the MCP server is in `packages/mcp`)
- npm: https://www.npmjs.com/package/@genclass/mcp (0.2.1, stdio, `npx -y @genclass/mcp@0.2.1`)
- Licence: Apache-2.0

`npm run catalog:build` (0 errors), `npm test` and `npm run typecheck` pass locally. The entry builds as `installReady` with stdio transport, auth none and 9 tools, and the sidecar validates against `schemas/server-metadata.schema.json`.

AI assistance: I used Claude (Claude Code) to draft this entry and the sidecar and to run the catalog build and tests. I reviewed the diff and checked every claim against the server myself. GenClass is a project I work on.
```

## If the maintainer asks

- **Only the bullet, no sidecar?** Remove the sidecar with
  `git rm data/server-metadata/github-genclass-dev-genclass-cafd8990.json` and push. The bullet alone still builds as
  installReady with stdio, auth none, 9 tools, Apache-2.0 and the clients Claude, Cursor, Codex and VS Code. The
  sidecar only adds the tool names, the docs and homepage links, and install confidence `high`.
- **Wrong category?** Say they can move it wherever they think fits. The other option is
  `docs/developer-productivity--utilities.md`, with the same line.
- **"Please star the repository" or the profile-claim form:** neither is a condition of the merge. Claiming the
  profile (`tensorblock.co/mcp/servers/github-genclass-dev-genclass-cafd8990`) is a later owner-account step, done
  through their `claim-profile.yml` issue form.
