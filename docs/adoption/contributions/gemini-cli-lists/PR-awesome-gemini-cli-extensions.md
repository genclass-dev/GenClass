# Pull request to Piebald-AI/awesome-gemini-cli-extensions

Prepared 2026-11-03 by the adoption swarm session `gemini-cli-lists`. Not sent. The sender opens it from a fork of
https://github.com/Piebald-AI/awesome-gemini-cli-extensions, on a branch off `main`, with
`upstream-awesome-gemini-cli-extensions.patch` applied (one line in `README.md`, nothing else). **Star the repository
from the sending account first** (see README.md in this folder, "The star gate").

## Title

```
Add GenClass to Development
```

(The form of the recent merged entries: "Add Ponder to Development" #122, "Add vidbyte-memory to Development" #114.)

## Body

The list's `.github/pull_request_template.md`, filled in, with the swarm's short disclosure at the end.

```markdown
## What are you adding?

- **Project:** GenClass
- **Section:** Development
- **Link:** https://github.com/genclass-dev/genclass-plugin

## How is it related to Gemini CLI extensions?

It is a Gemini CLI extension: `gemini-extension.json` starts the GenClass MCP server (`@genclass/mcp`, local stdio) and `skills/genclass/SKILL.md` is the `genclass` agent skill; `gemini extensions install https://github.com/genclass-dev/genclass-plugin` installs both, and `gemini extensions validate` passes on the repository.

## Checklist

- [x] I've read [AGENTS.md](https://github.com/Piebald-AI/awesome-gemini-cli-extensions/blob/main/AGENTS.md)
- [x] I've added the entry to the right section
- [x] I've starred the repo :star: (thank you!)

I work on GenClass. I used Claude (Claude Code) to draft this entry; I checked it and installed the extension in Gemini CLI myself.
```

## Before sending (the sender, by hand)

- [ ] Star https://github.com/Piebald-AI/awesome-gemini-cli-extensions from the account that opens the pull request.
- [ ] `git fetch` the list's `main` and check `## Development` still ends with Ponder; if not, put the line after the
      new last entry of `## Development` (not `## Utilities`, where NotWorking is).
- [ ] Search the list's pull requests for "genclass" (none on 2026-11-03).
- [ ] Run `gemini extensions install https://github.com/genclass-dev/genclass-plugin`, then `gemini extensions list`
      (shows the `genclass` MCP server and agent skill) and `gemini mcp list` ("Connected").
- [ ] Optional, after the merge: the "Mentioned in Awesome Gemini CLI Extensions" badge in the plugin README is the
      list's suggestion; genclass-plugin is generated from GenClass-lib by `packages/mcp/scripts/plugin-repo.mjs`, so a
      badge goes there, never into the plugin repository by hand.
