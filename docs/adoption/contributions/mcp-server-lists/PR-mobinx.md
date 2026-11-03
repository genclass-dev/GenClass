# Pull request to MobinX/awesome-mcp-list

Target: https://github.com/MobinX/awesome-mcp-list, base `main`. The body below is the repository's
`.github/PULL_REQUEST_TEMPLATE.md` filled in. Every box can be ticked truthfully. The last line is a one-line
AI-assistance note, since the list has no AI policy.

## Title

```
Add genclass-dev/GenClass to Developer Tools
```

## Body

````markdown
## What does this MCP server do?

GenClass's MCP server (`packages/mcp`, `@genclass/mcp` on npm) runs locally over stdio with `npx -y @genclass/mcp@0.2.1`. It needs no account or API key. It lets a coding agent read the race conditions recorded in a web app's development pages, re-run a page with network responses delivered in different orders, and replay one exact order to prove a fix.

-   **Repo URL:** https://github.com/genclass-dev/GenClass
-   **Category:** 💻 Developer Tools

## Entry

```markdown
-   **[genclass-dev/GenClass](https://github.com/genclass-dev/GenClass)** [![GitHub stars](https://img.shields.io/github/stars/genclass-dev/GenClass?style=social)](https://github.com/genclass-dev/GenClass): Local MCP server (packages/mcp, @genclass/mcp on npm) that reports race conditions recorded in a web app's development pages, re-runs a page with network responses delivered in different orders, and replays one order to prove a fix.
```

## Checklist

- [x] Public GitHub repo exists and is not archived
- [x] It is a real MCP server that people can run or connect to (not a website-only / hosted endpoint without a public repo)
- [x] Entry uses the exact format above (three spaces after `-`, bold linked `owner/repo`, stars badge for the **same** `owner/repo` with `style=social`, then `: ` and the description)
- [x] Placed in the best existing category
- [x] Not already listed in the README (I searched for my repo)
- [x] Description is accurate and one concise sentence, ending with a period
- [x] Diff is a single new bullet in `README.md` (no drive-by edits, no reformatting of unrelated lines)

AI assistance: I drafted this entry with Claude (Claude Code) and reviewed it myself. GenClass is a project I work on.
````

## If the maintainer asks

- **"The repository root is a browser library, not an MCP server."** The server is `packages/mcp` in that repository,
  published as `@genclass/mcp`. If they would rather link the subfolder, the list already does this for
  `@mastra/mcp` (README line 307: bold link to `.../tree/main/packages/mcp`, badge for the root repository). The
  alternative line is:
  `-   **[genclass-dev/GenClass](https://github.com/genclass-dev/GenClass/tree/main/packages/mcp)** [![GitHub stars](https://img.shields.io/github/stars/genclass-dev/GenClass?style=social)](https://github.com/genclass-dev/GenClass): ...` (same sentence).
- **The PR is closed with "Landed ... directly on main":** that means it was accepted. Check the README on `main` for
  the line. Don't read any closure as a rejection until you've checked the README.
