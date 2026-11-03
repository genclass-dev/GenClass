# Pull request to Piebald-AI/awesome-gemini-cli

Prepared 2026-11-03 by the adoption swarm session `gemini-cli-lists`. Not sent. The sender opens it from a fork of
https://github.com/Piebald-AI/awesome-gemini-cli, on a branch off `main`, with `upstream-awesome-gemini-cli.patch`
applied (one line in `README.md`, nothing else). **Star the repository from the sending account first** (see
README.md in this folder, "The star gate"): unstarred authors' pull requests are labelled `missing-star` and not
merged.

## Title

```
Add GenClass to MCP Servers
```

(The form of every recent merged entry: "Add repofit to MCP Servers" #314, "Add Keenable to MCP Servers" #313.)

## Body

The list's `.github/pull_request_template.md`, filled in. The last paragraph is the swarm's disclosure; the list asks
for no affiliation statement ("No need to disclose affiliation"), so it is short.

```markdown
## What are you adding?

- **Project:** GenClass
- **Section:** MCP Servers
- **Link:** https://github.com/genclass-dev/GenClass

## How is it related to Gemini CLI?

GenClass is a local stdio MCP server (`@genclass/mcp`) that Gemini CLI connects to with `gemini mcp add genclass npx -- -y @genclass/mcp@0.2.1`, or as a Gemini CLI extension with the server and a skill (`gemini extensions install https://github.com/genclass-dev/genclass-plugin`). It lets Gemini CLI see what happened in a web app's development pages, re-run a page with network responses delivered in different orders to find race conditions, and replay one order to prove a fix.

## Checklist

- [x] I've read [AGENTS.md](https://github.com/Piebald-AI/awesome-gemini-cli/blob/main/AGENTS.md)
- [x] I've added the entry to the right section
- [x] I've starred the repo :star: (thank you!)

I work on GenClass. I used Claude (Claude Code) to draft this entry; I checked it and ran both install commands in Gemini CLI myself.
```

## Before sending (the sender, by hand)

- [ ] Star https://github.com/Piebald-AI/awesome-gemini-cli from the account that opens the pull request (the third
      checklist box must be true).
- [ ] `git fetch` the list's `main` and check `## MCP Servers` still ends where the patch expects; if new entries
      landed, put the GenClass line after the new last entry (bottom of the section, AGENTS.md).
- [ ] Search the list's pull requests for "genclass" (none on 2026-11-03, README.md in this folder).
- [ ] Run both install lines in a current Gemini CLI and see `gemini mcp list` say "Connected" (this session's run:
      README.md, "Checks run"), so the disclosure sentence is true.
- [ ] If `@genclass/mcp` has a newer `latest` than 0.2.1 by then, update the pinned version in the line (the plugin
      repository pins the same version in `gemini-extension.json`).
